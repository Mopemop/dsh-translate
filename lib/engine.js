/**
 * 翻译引擎（宿主半侧）：把一次划词翻译变成一次模型调用，并把流式结果收敛成结果协议。
 *
 * ## 为什么单独一个文件
 *
 * 这里**不 import 任何 DSH 包**：`llm` 服务、默认模型选择、超时、时钟全部由调用方注入。
 * 于是整条"发请求 → 收分片 → 判终止原因 → 组装译文"的链路可以在 Node 里用一个假的
 * `llm.stream` 异步生成器完整跑一遍（见 test/engine.test.mjs），不需要真的起 DSH、
 * 也不花 token。
 *
 * ## 结果协议（与客户端 src/client/translate.js 对齐）
 *
 *   { state: 'done',  text, target, engine: { provider, model }, usage, elapsedMs }
 *   { state: 'error', error, code }
 *
 * `error` 是给用户看的一句话；`code` 是给程序看的稳定标识（引擎失败码原样透传，
 * 例如 RATE_LIMIT / ACCOUNT_QUOTA / NO_ADAPTER）。
 */

/**
 * 语言代码 → 自然语言名（写进提示词）。客户端只发代码，名字由这里决定。
 *
 * ⚠️ 这份表必须与客户端的 `LANGUAGE_LABELS` **键集合一致**：客户端能选到、
 * 这里却认不出来的语言，会静默回落成"简体中文"——用户选了瑞典语却被告知翻成中文，
 * 而且译文看起来"就是不对"，很难查。render.test.mjs 里有一条用例专门比对两边。
 */
export const LANGUAGE_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  pt: '葡萄牙语',
  it: '意大利语',
  ru: '俄语',
  uk: '乌克兰语',
  pl: '波兰语',
  cs: '捷克语',
  sk: '斯洛伐克语',
  hu: '匈牙利语',
  ro: '罗马尼亚语',
  bg: '保加利亚语',
  el: '希腊语',
  tr: '土耳其语',
  nl: '荷兰语',
  sv: '瑞典语',
  da: '丹麦语',
  no: '挪威语',
  fi: '芬兰语',
  is: '冰岛语',
  et: '爱沙尼亚语',
  lv: '拉脱维亚语',
  lt: '立陶宛语',
  sl: '斯洛文尼亚语',
  hr: '克罗地亚语',
  sr: '塞尔维亚语',
  bs: '波斯尼亚语',
  mk: '马其顿语',
  sq: '阿尔巴尼亚语',
  he: '希伯来语',
  ar: '阿拉伯语',
  fa: '波斯语',
  ur: '乌尔都语',
  hi: '印地语',
  bn: '孟加拉语',
  ta: '泰米尔语',
  te: '泰卢固语',
  mr: '马拉地语',
  gu: '古吉拉特语',
  kn: '卡纳达语',
  ml: '马拉雅拉姆语',
  pa: '旁遮普语',
  ne: '尼泊尔语',
  si: '僧伽罗语',
  th: '泰语',
  vi: '越南语',
  id: '印尼语',
  ms: '马来语',
  fil: '菲律宾语',
  km: '高棉语',
  lo: '老挝语',
  my: '缅甸语',
  mn: '蒙古语',
  kk: '哈萨克语',
  uz: '乌兹别克语',
  az: '阿塞拜疆语',
  hy: '亚美尼亚语',
  ka: '格鲁吉亚语',
  sw: '斯瓦希里语',
  am: '阿姆哈拉语',
  af: '南非荷兰语',
  zu: '祖鲁语',
  cy: '威尔士语',
  ga: '爱尔兰语',
  gl: '加利西亚语',
};

/** 看起来像语言代码吗（两三个字母 + 可选的地区子标签）。 */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/** 默认目标语言（客户端没给目标时用）。 */
export const DEFAULT_TARGET = 'zh-CN';

/** 默认源语言：交给引擎自己判断。 */
export const DEFAULT_SOURCE = 'auto';

/** 输入上限：超过就截断（客户端已经截过一次，这里是防直接调 API 的兜底）。 */
export const MAX_INPUT_CHARS = 6000;

/**
 * 输出 token 上限的边界。
 *
 * ⚠️ 上限必须给足：**推理模型的思考 token 也算在这个预算里**。
 * 卡片的实测故障就是"模型没有返回内容"——预算被思考吃光、可见文本一个字都没出来
 * （机器上跑的是带推理的 flash 模型，一段 500 字符的段落配上原先 1.5×字符数的估算
 * 很容易撞线）。所以下限抬到 2048，并按输入长度给更宽的余量。
 */
export const MIN_OUTPUT_TOKENS = 2048;
export const MAX_OUTPUT_TOKENS = 8192;

/**
 * 系统提示词。
 *
 * 每条规则都对应一种真实会出问题的输出：
 *   1. 不要解释 —— 否则卡片里会出现"以下是译文："这种前言；
 *   2. 保留换行 —— 代码片段与段落结构是选区信息的一部分；
 *   3. 代码/URL 保持原样 —— 翻译 `ctx.slots.inject` 或文件路径毫无意义且有害；
 *   4. 已经是目标语言就原样返回 —— 用户可能选中一段中文，不该被"翻译"成中文；
 *   5. 无法翻译的内容原样返回 —— 纯符号、乱码不要变成解释。
 */
export const SYSTEM_PROMPT = [
  '你是一个翻译引擎。把用户发来的文本翻译成指定的目标语言。',
  '',
  '规则：',
  '1. 只输出译文本身。不要任何解释、前言、总结、引号或 Markdown 代码块包装。',
  '2. 保留原文的换行与段落结构。',
  '3. 代码标识符、命令行、URL、文件路径、变量名保持原样，不要翻译。',
  '4. 如果原文已经是目标语言，原样返回。',
  '5. 无法翻译的内容（纯符号、乱码）原样返回。',
].join('\n');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 语言代码归一（表里认不出来时回落）。
 *
 * ⚠️ 两种情况必须分开：
 *   · **看起来就是语言代码**（`sv`、`pt-BR`）→ **原样留着**，别回落。
 *     回落到中文等于告诉模型"目标语言是简体中文"，用户选了瑞典语却拿到中文译文，
 *     而且界面上没有任何异常提示 —— 静默错译比报错难查得多。
 *   · 真的不像代码（`klingon`、空串）→ 才用 fallback。
 */
function normalizeLanguage(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const raw = value.trim();
  if (LANGUAGE_NAMES[raw] !== undefined) return raw;
  const lower = raw.toLowerCase();
  for (const code of Object.keys(LANGUAGE_NAMES)) {
    if (code.toLowerCase() === lower) return code;
  }
  const base = lower.split('-')[0];
  const prefix = base + '-';
  for (const code of Object.keys(LANGUAGE_NAMES)) {
    // 前缀也算命中：用户可能只给 "zh" / "en"，要补成 zh-CN / en 这类具体代码
    if (code.toLowerCase() === base || code.toLowerCase().startsWith(prefix)) return code;
  }
  return LANGUAGE_TAG.test(raw) ? raw : fallback;
}

/** 目标语言代码归一（认不出来就回落默认目标）。 */
export function normalizeTarget(target) {
  return normalizeLanguage(target, DEFAULT_TARGET);
}

/** 目标语言的自然语言名（写进提示词用）。 */
export function languageName(target) {
  const code = normalizeTarget(target);
  // 表里没有的语言直接用代码：模型认得出 "sv"，而"简体中文"是错的
  return LANGUAGE_NAMES[code] ?? code;
}

/**
 * 源语言代码归一。
 *
 * 与目标是**两件事**：源语言允许 `auto`（默认，交给引擎自己判断），
 * 目标不允许 —— "翻译成自动"没有意义。
 */
export function normalizeSource(source) {
  if (typeof source !== 'string' || source.trim() === '') return DEFAULT_SOURCE;
  const value = source.trim();
  const lower = value.toLowerCase();
  if (lower === 'auto' || lower === 'auto-detect') return DEFAULT_SOURCE;
  // 源语言认不出来时回落 auto（让引擎自己判断），不回落到中文
  return normalizeLanguage(value, DEFAULT_SOURCE);
}

/** 源语言的自然语言名（auto 时说"自动判断"）。 */
export function sourceName(source) {
  const code = normalizeSource(source);
  return code === DEFAULT_SOURCE ? '自动判断' : languageName(code);
}

/** 组装请求消息。翻译是"一段文本进、一段文本出"，所以只有一条 user 消息。 */
export function buildMessages(text, target, source) {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          // 源语言也写进去：用户手动指定了原文语言时（例如"这是日语不是中文"），
          // 明确告诉模型比让它自己猜更不容易译错
          text: '源语言：' + sourceName(source) + '\n目标语言：' + languageName(target) + '\n\n待翻译文本：\n' + text,
        },
      ],
    },
  ];
}

/**
 * 输出上限估算。
 *
 * 两个真实约束：
 *   1. **推理 token 也算在预算里**（见 MIN_OUTPUT_TOKENS 的说明），所以必须留出
 *      足够余量，否则会得到"有思考、没译文"的空结果；
 *   2. 不设上限时个别模型会自行发挥（补全、解释），所以要夹住。
 *
 * 取「字符数 × 2 + 2048」：×2 覆盖中英互译的膨胀（中文 token 密度高），
 * +2048 是思考余量；上下限再夹一次。
 */
export function estimateMaxTokens(text) {
  const chars = typeof text === 'string' ? text.length : 0;
  return clamp(Math.ceil(chars * 2) + 2048, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
}

/** 调用请求里的路由与参数（从默认模型选择里取，取不到就用兜底常量）。 */
export function resolveSelection(selection) {
  const provider = selection !== null && selection !== undefined && typeof selection.provider === 'string' && selection.provider !== '' ? selection.provider : 'deepseek-account';
  const model = selection !== null && selection !== undefined && typeof selection.model === 'string' && selection.model !== '' ? selection.model : 'deepseek-flash';
  const resolved = { provider, model };
  // ⚠️ 不透传 reasoningEffort：默认选择里的 high 是为"写代码"设的，
  // 翻译要的是快。省略时由适配器给默认值（通常更省）。
  return resolved;
}

/** 引擎失败码 → 一句人话。认不出的码原样带出（绝不吞掉 code）。 */
export function failureMessage(failure) {
  const code = failure !== null && failure !== undefined && typeof failure.code === 'string' ? failure.code : '';
  const detail = failure !== null && failure !== undefined && typeof failure.message === 'string' && failure.message !== '' ? failure.message : '';
  const table = {
    NO_ADAPTER: '宿主没有注册这个模型提供方',
    MISSING_CREDENTIAL: '缺少模型凭据（先在设置里登录或配置 API key）',
    INVALID_CREDENTIAL: '模型凭据无效',
    ACCOUNT_SIGN_IN_REQUIRED: 'DeepSeek 账号未登录（设置 → 账号）',
    AUTH: '模型鉴权失败',
    QUOTA: '模型额度已用完',
    ACCOUNT_QUOTA: '账号余额不足',
    RATE_LIMIT: '请求太快被限流，稍后再试',
    CONTEXT_WINDOW_EXCEEDED: '选区太长，超出模型上下文',
  };
  if (table[code] !== undefined) return detail === '' ? table[code] : table[code] + '（' + detail + '）';
  if (detail !== '') return detail;
  if (code !== '') return '翻译失败：' + code;
  return '翻译失败';
}

/**
 * 剥掉模型可能加上的代码块包装。
 *
 * 提示词里已经明说不要包装，但实测这类"礼貌的越界"仍会发生，
 * 而 ``` 出现在卡片里非常显眼 —— 所以这里做一层确定性清理：
 * 只有当整个输出**恰好**被一对围栏包住时才剥（不做贪婪替换，避免误伤正文里真的代码块）。
 */
export function stripCodeFence(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  const match = /^```[a-zA-Z0-9+-]*\n([\s\S]*?)\n?```$/.exec(value);
  return match === null ? value : match[1].trim();
}

function describe(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/**
 * 跑一次翻译。
 *
 * @param input - { text: string, target?: string, source?: string }
 * @param deps - { llm, selection?, timeoutMs?, now? }
 * @returns Promise<result>（见文件头协议）
 */
export async function runTranslation(input, deps) {
  const options = deps ?? {};
  const llm = options.llm;
  const raw = input !== null && input !== undefined && typeof input.text === 'string' ? input.text : '';
  const text = raw.length > MAX_INPUT_CHARS ? raw.slice(0, MAX_INPUT_CHARS) : raw;
  const truncated = raw.length > MAX_INPUT_CHARS;
  const target = normalizeTarget(input === null || input === undefined ? undefined : input.target);
  const source = normalizeSource(input === null || input === undefined ? undefined : input.source);

  if (text.trim() === '') return { state: 'error', error: '没有可翻译的文本', code: 'EMPTY_INPUT' };
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
    return { state: 'error', error: '宿主没有可用的 llm 服务（本插件的宿主半侧没加载？）', code: 'NO_LLM_SERVICE' };
  }

  const selection = resolveSelection(options.selection);
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = controller === null ? null : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const started = now();
  const pieces = [];
  const blockTexts = [];
  let usage = null;
  let finish = null;
  // 分片计数：空结果时用来回答"模型到底产出了什么"（思考？工具调用？什么都没有？）
  const counts = { text: 0, reasoning: 0, tool: 0, other: 0 };

  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: SYSTEM_PROMPT,
      messages: buildMessages(text, target, source),
      temperature: 0,
      maxTokens: estimateMaxTokens(text),
      ...(controller === null ? {} : { signal: controller.signal }),
    });
    for await (const chunk of stream) {
      if (chunk === null || chunk === undefined) continue;
      if (chunk.type === 'text-delta') {
        counts.text++;
        pieces.push(typeof chunk.text === 'string' ? chunk.text : '');
      }
      // 兜底：适配器可以只给 block-end（不给 token 级 delta）。
      // DSH 自己的消费方用 BlockAssembler 处理这件事，而它是内部包、外部插件 import 不到，
      // 所以这里自己收一份 block 级文本，最后看哪条路拿到了内容。
      else if (chunk.type === 'block-end' && chunk.block !== null && chunk.block !== undefined && chunk.block.type === 'text') {
        blockTexts.push(typeof chunk.block.text === 'string' ? chunk.block.text : '');
      } else if (chunk.type === 'reasoning-delta') counts.reasoning++;
      else if (chunk.type === 'tool-call-delta' || chunk.type === 'tool-call') counts.tool++;
      else if (chunk.type === 'usage') usage = chunk.usage;
      else if (chunk.type === 'finish') finish = chunk.reason;
      else counts.other++;
    }
  } catch (error) {
    if (timer !== null) clearTimeout(timer);
    // 用户取消或超时都走这条路：给出可读原因，而不是把 AbortError 抛给卡片
    if (timedOut) return { state: 'error', error: '翻译超时（' + Math.round(timeoutMs / 1000) + 's），可以重试', code: 'TIMEOUT' };
    const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : 'THROWN';
    return { state: 'error', error: describe(error), code };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (finish !== null && finish !== undefined && finish.kind === 'error') {
    const code = finish.failure !== null && finish.failure !== undefined && typeof finish.failure.code === 'string' ? finish.failure.code : 'ENGINE_ERROR';
    return { state: 'error', error: failureMessage(finish.failure), code };
  }
  if (finish !== null && finish !== undefined && finish.kind === 'aborted') {
    return { state: 'error', error: timedOut ? '翻译超时，可以重试' : '翻译被取消', code: timedOut ? 'TIMEOUT' : 'ABORTED' };
  }

  const joined = pieces.join('');
  const translated = stripCodeFence(joined.trim() === '' ? blockTexts.join('') : joined);
  if (translated === '') {
    // 空结果必须自述原因，否则只能看到"模型没有返回内容"这种没法下手的提示
    const kind = finish !== null && finish !== undefined && typeof finish.kind === 'string' ? finish.kind : 'unknown';
    const detail = '分片：文本 ' + counts.text + ' / 思考 ' + counts.reasoning + ' / 工具 ' + counts.tool + ' / 其它 ' + counts.other;
    if (kind === 'max-tokens' && counts.text + blockTexts.length === 0) {
      return {
        state: 'error',
        error: '模型把输出预算（' + estimateMaxTokens(text) + ' tokens）全花在了思考上，没产出译文；可以重试，或把选区缩小一点',
        code: 'OUTPUT_BUDGET_EXHAUSTED',
        finishKind: kind,
        counts: counts,
      };
    }
    return {
      state: 'error',
      error: '模型没有返回可见文本（finish=' + kind + '；' + detail + '）',
      code: 'EMPTY_OUTPUT',
      finishKind: kind,
      counts: counts,
    };
  }

  return {
    state: 'done',
    text: translated,
    target,
    engine: { provider: selection.provider, model: selection.model },
    usage,
    elapsedMs: Math.max(0, Math.round(now() - started)),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * 结果缓存。
 *
 * 划词翻译的重复度很高（同一段话被反复选中、翻完再看一遍），而模型调用是这里唯一
 * 花钱又慢的一步。用最朴素的"到上限丢最旧"策略：够用、可预测、不会无限涨。
 */
export function createCache(limit) {
  const max = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 200;
  const store = new Map();
  return {
    get(key) {
      if (!store.has(key)) return undefined;
      const value = store.get(key);
      // 取用即刷新，让热条目活得更久
      store.delete(key);
      store.set(key, value);
      return value;
    },
    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      while (store.size > max) {
        const oldest = store.keys().next();
        if (oldest.done === true) break;
        store.delete(oldest.value);
      }
    },
    get size() {
      return store.size;
    },
    clear() {
      store.clear();
    },
  };
}

/**
 * 缓存键。
 *
 * 四个维度都要进键：同一段文本在不同目标语言下结果不同；
 * 在不同引擎下也不同（微软与 Google 的译文措辞不一样，
 * 用户点了引擎切换就该看到另一家的结果，而不是拿到缓存里那家的）；
 * **源语言也要进**——"自动检测"和"手动指定为日语"可能得到不同译文，
 * 不复现用户看到的那个问题就白加了缓存。
 */
export function cacheKey(text, target, engine, source) {
  const route = typeof engine === 'string' && engine !== '' ? engine : 'auto';
  return route + '\u0000' + normalizeTarget(target) + '\u0000' + normalizeSource(source) + '\u0000' + text;
}

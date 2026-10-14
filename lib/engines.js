/**
 * 传统翻译引擎（宿主半侧）：微软翻译与 Google 翻译。
 *
 * ## 为什么这两家必须在宿主侧发请求
 *
 * 页面 origin 是 `dsh-app://app`，而这两家的端点都不带 CORS 头 —— 从页面直接
 * fetch 一定被浏览器拦。所以链路与本插件的模型路径一致：
 *
 *   卡片 ──► 宿主路由 /dsh-translate/api/translate ──► 本文件 ──► 翻译端点
 *
 * ## 免费端点 vs 官方 API
 *
 * 两个引擎各有两种模式，靠"有没有配 key"自动切换：
 *
 *   微软  无 key：`edge.microsoft.com/translate/auth` 取一个 10 分钟有效的 JWT，
 *                 再打 `api-edge.cognitive.microsofttranslator.com`
 *         有 key：Azure Translator（`api.cognitive.microsofttranslator.com` + Ocp-Apim-Subscription-Key）
 *   Google 无 key：`translate.googleapis.com/translate_a/single`（gtx 客户端端点）
 *          有 key：Cloud Translation v2（`translation.googleapis.com/language/translate/v2`）
 *
 * 免费端点无需凭据，但有两点必须接受：**可能被限流**，以及**网络可达性看你的线路**
 * （实测大陆直连时微软这条通、Google 那条不通）。
 *
 * ## 可测性
 *
 * 本文件不直接读全局 fetch：`deps.fetch` 才是指令通道；时间、UA、token 缓存
 * 也都可注入。于是所有解析、重试、错误映射、回退顺序都能在 Node 里用假 fetch
 * 跑完（见 test/engines.test.mjs），不联网。
 */

/** 引擎 id 与显示名（客户端也用同一套 id）。 */
export const ENGINE_LABELS = {
  microsoft: '微软翻译',
  google: 'Google 翻译',
  llm: '模型',
};

/** 自动模式的默认顺序。
 *
 * 把微软放第一位是有依据的：实测大陆直连时 `edge.microsoft.com` 可达，
 * 而 `translate.googleapis.com` 不可达。Google 放在中间，配了代理/TUN 的线路
 * 上它一样能用；模型垫底，保证"两家传统引擎都挂"时仍然有结果。 */
export const DEFAULT_ORDER = ['microsoft', 'google', 'llm'];

/** 微软免费端点的两个地址。 */
const MICROSOFT_AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const MICROSOFT_EDGE_TRANSLATE_URL = 'https://api-edge.cognitive.microsofttranslator.com/translate';
/** 微软官方 API（配了 key 时用）。 */
const MICROSOFT_AZURE_URL = 'https://api.cognitive.microsofttranslator.com/translate';
/**
 * Bing 网页版翻译（免费模式的后备通道）。
 *
 * 用 `cn.bing.com` 而不是 `www.bing.com`：后者会 302 到前者（实测），
 * 而按区域直连可以少一次跨域重定向。
 */
const BING_ORIGIN = 'https://cn.bing.com';
const BING_TRANSLATOR_URL = BING_ORIGIN + '/translator';
const BING_TRANSLATE_URL = BING_ORIGIN + '/ttranslatev3';
/** Google 免费端点与官方 API。 */
const GOOGLE_FREE_URL = 'https://translate.googleapis.com/translate_a/single';
const GOOGLE_OFFICIAL_URL = 'https://translation.googleapis.com/language/translate/v2';

/** 免费端点用的浏览器 UA：两家都会对"看起来不像浏览器"的请求更苛刻。 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';

/** 看起来像语言代码吗（与 engine.js 同一个判据，用于决定"透传"还是"兜底"）。 */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * 语言代码映射（**只列与规范写法不同的那些**）。
 *
 * 为什么不把整张语言表抄两遍：两家接口都接受 ISO-639-1 的原样写法（`sv`、`th`、`vi`…），
 * 抄一份完整表意味着每加一门语言要改三处、还可能抄错。所以这里只写例外，
 * 其余原样透传（见 languageCodeFor）。
 *
 *   · 微软把中文分成 zh-Hans / zh-Hant，**不认** zh-CN；塞尔维亚语要 sr-Cyrl、
 *     蒙古语要 mn-Cyrl，挪威语叫 nb，菲律宾语叫 fil；
 *   · Google 的菲律宾语用 tl，繁体中文只认 zh-TW（zh-HK 要折过去）；
 *   · 模型那路写的是自然语言名（见 engine.js 的 LANGUAGE_NAMES）。
 */
const LANGUAGE_CODES = {
  microsoft: {
    'zh-CN': 'zh-Hans',
    'zh-TW': 'zh-Hant',
    'zh-HK': 'zh-Hant',
    sr: 'sr-Cyrl',
    mn: 'mn-Cyrl',
    no: 'nb',
  },
  google: {
    'zh-HK': 'zh-TW',
    fil: 'tl',
  },
};

/** 单个引擎的结果协议（与 engine.js 的模型路径保持一致，只多一个 engine.id/label）。 */
function done(id, text, extra) {
  return Object.assign(
    {
      state: 'done',
      text: text,
      engine: { id: id, label: ENGINE_LABELS[id] },
    },
    extra ?? {},
  );
}

function failed(id, message, code, extra) {
  return Object.assign(
    {
      state: 'error',
      text: '',
      error: message,
      code: code,
      engine: { id: id, label: ENGINE_LABELS[id] },
    },
    extra ?? {},
  );
}

/**
 * 语言码在该引擎下的写法。
 *
 * 源语言与目标语言共用（同一门语言在两处写法一致），所以函数名说的是"语言"。
 *
 * 三条规则：
 *   1. 表里有例外写法 → 用例外；
 *   2. 没有例外但**看起来是语言代码** → 原样发出去（两家都接受 ISO-639-1，
 *      抄全表只会有抄错的风险）；
 *   3. 真的不像代码 → 才用兜底值。
 */
export function languageCodeFor(engineId, language) {
  const table = LANGUAGE_CODES[engineId];
  const fallback = engineId === 'microsoft' ? 'zh-Hans' : 'zh-CN';
  if (typeof language !== 'string' || language === '') return fallback;
  if (table !== undefined && table[language] !== undefined) return table[language];
  return LANGUAGE_TAG.test(language) ? language : fallback;
}

/**
 * 源语言交给引擎时的写法：`auto` 表示"让它自己判断"。
 *
 * 微软/Google 都支持"不传源语言就是自动检测"，所以 auto 时返回空串，
 * 由调用方决定是省略参数还是写 `auto`/`auto-detect`。
 */
export function sourceCodeFor(engineId, source) {
  if (typeof source !== 'string' || source === '' || source.toLowerCase() === 'auto') return '';
  return languageCodeFor(engineId, source);
}

// ----------------------------------------------------------------- Google 解析

/**
 * 解析 Google 的响应。
 *
 * 两种形态都要认，因为免费端点在不同 `client`/参数下给的形状不一样：
 *   · `dj=1`：`{ sentences: [{ trans, orig }], src: 'en' }`  —— 本插件默认用这个；
 *   · 经典嵌套数组：`[[["译文","原文",...],...],null,"en",...]`
 * 认不出来就返回 null，由调用方当成"没有内容"，而不是返回一个空串让上层以为成功。
 */
export function parseGoogleBody(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.sentences)) {
    const text = body.sentences
      .map((row) => (row !== null && row !== undefined && typeof row.trans === 'string' ? row.trans : ''))
      .join('');
    if (text === '') return null;
    return { text: text, detected: typeof body.src === 'string' && body.src !== '' && body.src !== 'auto' ? body.src : undefined };
  }
  if (Array.isArray(body)) {
    const rows = body[0];
    if (!Array.isArray(rows)) return null;
    let text = '';
    for (const row of rows) {
      if (Array.isArray(row) && typeof row[0] === 'string') text += row[0];
    }
    if (text === '') return null;
    const detected = typeof body[2] === 'string' && body[2] !== '' && body[2] !== 'auto' ? body[2] : undefined;
    return { text: text, detected: detected };
  }
  // 官方 v2：{ data: { translations: [{ translatedText, detectedSourceLanguage }] } }
  if (body.data !== null && body.data !== undefined && Array.isArray(body.data.translations)) {
    const first = body.data.translations[0];
    if (first === null || first === undefined || typeof first.translatedText !== 'string' || first.translatedText === '') return null;
    return {
      text: first.translatedText,
      detected: typeof first.detectedSourceLanguage === 'string' && first.detectedSourceLanguage !== '' ? first.detectedSourceLanguage : undefined,
    };
  }
  return null;
}

/** 解析微软的响应：`[{ detectedLanguage, translations: [{ text, to }] }]` */
export function parseMicrosoftBody(body) {
  if (!Array.isArray(body) || body.length === 0) return null;
  const first = body[0];
  if (first === null || first === undefined) return null;
  const translations = first.translations;
  if (!Array.isArray(translations) || translations.length === 0) return null;
  const row = translations[0];
  if (row === null || row === undefined || typeof row.text !== 'string' || row.text === '') return null;
  const detected =
    first.detectedLanguage !== null && first.detectedLanguage !== undefined && typeof first.detectedLanguage.language === 'string' && first.detectedLanguage.language !== ''
      ? first.detectedLanguage.language
      : undefined;
  return { text: row.text, detected: detected };
}

// ----------------------------------------------------------------- 错误映射

/** HTTP 状态 → 一句人话 + 稳定 code。 */
export function httpFailure(engineId, status) {
  const label = ENGINE_LABELS[engineId] ?? engineId;
  if (status === 429) return { message: label + ' 请求过于频繁（HTTP 429），稍后再试或换一个引擎', code: 'RATE_LIMIT' };
  if (status === 401 || status === 403) return { message: label + ' 拒绝了这个请求（HTTP ' + status + '）：通常是没有 key 或免费端点改了口径', code: 'AUTH' };
  if (status === 404) return { message: label + ' 的接口地址已失效（HTTP 404）：免费端点可能已下线', code: 'ENDPOINT_MISSING' };
  // 400 最常见的成因是语言代码不被这家接受（语言表有几十门，很容易选中一家不支持的）
  if (status === 400) return { message: label + ' 不接受这次请求（HTTP 400）：通常是语言代码不对或文本为空，换一门语言或换引擎试试', code: 'BAD_REQUEST' };
  if (status >= 500) return { message: label + ' 服务端错误（HTTP ' + status + '）', code: 'UPSTREAM' };
  return { message: label + ' 返回 HTTP ' + status, code: 'HTTP_' + status };
}

/**
 * 网络层失败 → 一句人话。
 *
 * 这类失败在大陆网络下极常见（域名被墙、需要代理），而默认错误串只有
 * `fetch failed` 四个字，用户根本无从下手，所以这里直接把排查方向写出来。
 */
export function networkFailure(engineId, error) {
  const label = ENGINE_LABELS[engineId] ?? engineId;
  const detail = error !== null && error !== undefined && error.message !== undefined ? error.message : String(error ?? '');
  const hint =
    engineId === 'google'
      ? '（Google 的域名在大陆直连不通；可给 DSH 配代理，或把顺序里 Google 后面留一个可用引擎）'
      : '（这条线路可能不通：检查网络或代理）';
  return { message: label + ' 网络不可达：' + detail + hint, code: 'UNREACHABLE' };
}

// ----------------------------------------------------------------- 取数工具

/** 带超时的 fetch：返回 { status, json, text, headers } 或抛错。 */
async function requestJson(fetchFn, url, init, timeoutMs, label) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer =
    controller === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
  try {
    const withSignal = controller === null ? init : Object.assign({}, init, { signal: controller.signal });
    const response = await fetchFn(url, withSignal);
    const status = typeof response.status === 'number' ? response.status : 0;
    let text = '';
    try {
      text = typeof response.text === 'function' ? await response.text() : '';
    } catch (error) {
      text = '';
    }
    let json;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch (error) {
      json = undefined;
    }
    // headers 一并带出去：Bing 网页版流程要靠 Set-Cookie 续会话
    return { status: status, json: json, text: text, headers: response.headers };
  } catch (error) {
    if (timedOut) {
      const failure = new Error(label + ' 超时（' + Math.round(timeoutMs / 1000) + 's）');
      failure.code = 'TIMEOUT';
      throw failure;
    }
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 微软免费端点的 token 缓存。
 *
 * 为什么要缓存：`edge.microsoft.com/translate/auth` 每次调用都要多一个来回，
 * 而 token 的有效期是 10 分钟。缓存 8 分钟后过期重取；遇到 401 再强制失效一次，
 * 让"token 提前失效"这种情形最多多花一个来回。
 */
export function createMicrosoftTokenCache() {
  let token = null;
  let expiresAt = 0;
  return {
    /** 取 token（没过期就直接返回缓存）。 */
    async get(fetchFn, timeoutMs, now) {
      const clock = typeof now === 'function' ? now : () => Date.now();
      const current = clock();
      if (token !== null && current < expiresAt) return token;
      const response = await requestJson(
        fetchFn,
        MICROSOFT_AUTH_URL,
        { method: 'GET', headers: { 'user-agent': DEFAULT_USER_AGENT, accept: '*/*' } },
        timeoutMs,
        ENGINE_LABELS.microsoft,
      );
      if (response.status !== 200 || typeof response.text !== 'string' || response.text.trim() === '') {
        const failure = new Error('取 token 失败（HTTP ' + response.status + '）');
        failure.code = 'AUTH';
        throw failure;
      }
      token = response.text.trim();
      expiresAt = current + 8 * 60 * 1000;
      return token;
    },
    /** 标记失效（401 时用）。 */
    invalidate() {
      token = null;
      expiresAt = 0;
    },
    /** 当前是否有缓存（测试接缝）。 */
    peek() {
      return token;
    },
  };
}

// ----------------------------------------------------------------- 引擎实现

/**
 * 微软翻译。
 *
 * 三条通道，按"能不能用"的顺序试：
 *   ① 配了 Azure key → 官方 API（最稳，直接返回）
 *   ② `edge.microsoft.com/translate/auth` 取 JWT → api-edge（历史上最快）
 *   ③ **Bing 网页版**：拿翻译页里的 `params_AbusePreventionHelper` + `IG`，
 *      再打 `ttranslatev3`
 *
 * 为什么要加 ③：实测这台机器上 ② 已经返回 **HTTP 404**（端点没了或被按区域重定向到
 * 一个不存在的路径），而 `cn.bing.com/translator` 返回 200。所以免费模式下必须能落到
 * Bing 网页版，否则"默认用微软翻译"就成了一句空话。
 *
 * @param input - { text, target }
 * @param deps - { fetch, config, tokenCache, timeoutMs, now }
 */
export async function runMicrosoft(input, deps) {
  const config = deps.config ?? {};
  if (typeof config.microsoftApiKey === 'string' && config.microsoftApiKey !== '') {
    return runMicrosoftAzure(input, deps);
  }

  // 两条免费通道共享**同一个时间预算**：否则一条挂住 8s、另一条再挂 8s，
  // 用户为一个引擎等 16s。edge 正常 404 只要几百毫秒，剩下的预算足够 Bing 用。
  const budget = deps.timeoutMs ?? 8000;
  const started = Date.now();
  const edge = await runMicrosoftEdge(input, deps);
  if (edge.state === 'done') return edge;

  const remaining = Math.max(1, budget - (Date.now() - started));
  const bing = await runMicrosoftBing(input, Object.assign({}, deps, { timeoutMs: remaining }));
  if (bing.state === 'done') return Object.assign(bing, { attempts: [briefFailure(edge)], via: 'bing' });

  return Object.assign(
    failed(
      'microsoft',
      '微软翻译两条免费通道都失败 —— edge 通道：' + withoutLabel(edge.error) + '；Bing 网页版：' + withoutLabel(bing.error),
      'ALL_FREE_CHANNELS_FAILED',
    ),
    { attempts: [briefFailure(edge), briefFailure(bing)] },
  );
}

/** 去掉子消息里重复的引擎前缀（聚合信息里已经写明了是哪条通道）。 */
function withoutLabel(text) {
  const message = typeof text === 'string' ? text : '';
  return message.replace(/^微软翻译[：:]\s*/, '');
}

/** 微软官方 API（配了 key 时）。 */
async function runMicrosoftAzure(input, deps) {
  const fetchFn = deps.fetch;
  const config = deps.config ?? {};
  const timeoutMs = deps.timeoutMs ?? 8000;
  const started = Date.now();
  const headers = { 'content-type': 'application/json', 'user-agent': DEFAULT_USER_AGENT, 'Ocp-Apim-Subscription-Key': config.microsoftApiKey };
  if (typeof config.microsoftRegion === 'string' && config.microsoftRegion !== '') headers['Ocp-Apim-Subscription-Region'] = config.microsoftRegion;

  try {
    const url = new URL(MICROSOFT_AZURE_URL);
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('to', languageCodeFor('microsoft', input.target));
    const from = sourceCodeFor('microsoft', input.source);
    if (from !== '') url.searchParams.set('from', from);
    const response = await requestJson(fetchFn, url.href, { method: 'POST', headers: headers, body: JSON.stringify([{ Text: input.text }]) }, timeoutMs, ENGINE_LABELS.microsoft);
    if (response.status !== 200) {
      const failure = httpFailure('microsoft', response.status);
      return failed('microsoft', failure.message, failure.code);
    }
    const parsed = parseMicrosoftBody(response.json);
    if (parsed === null) return failed('microsoft', '微软翻译没有返回可用的译文', 'EMPTY_OUTPUT');
    return done('microsoft', parsed.text, { target: input.target, detected: parsed.detected, elapsedMs: Math.max(0, Date.now() - started), official: true });
  } catch (error) {
    if (error !== null && error !== undefined && error.code === 'TIMEOUT') return failed('microsoft', error.message, 'TIMEOUT');
    const failure = networkFailure('microsoft', error);
    return failed('microsoft', failure.message, failure.code);
  }
}

/** 微软 edge 端点（免费 JWT 那条）。 */
async function runMicrosoftEdge(input, deps) {
  const fetchFn = deps.fetch;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const started = Date.now();

  try {
    const url = new URL(MICROSOFT_EDGE_TRANSLATE_URL);
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('to', languageCodeFor('microsoft', input.target));
    // 源语言：留空 = 让微软自动检测
    const from = sourceCodeFor('microsoft', input.source);
    if (from !== '') url.searchParams.set('from', from);
    url.searchParams.set('includeSentenceLength', 'true');

    // ⚠️ 调用方应当传共享的 tokenCache（路由就是这么做的）。没传时这里按"本次调用"
    // 建一个 —— 功能正确但每次都会重取 token，属于"少了优化"而不是"错了"。
    const cache = deps.tokenCache ?? createMicrosoftTokenCache();
    const headers = { 'content-type': 'application/json', 'user-agent': DEFAULT_USER_AGENT, authorization: 'Bearer ' + (await cache.get(fetchFn, timeoutMs, deps.now)) };
    const body = JSON.stringify([{ Text: input.text }]);
    let response = await requestJson(fetchFn, url.href, { method: 'POST', headers: headers, body: body }, timeoutMs, ENGINE_LABELS.microsoft);

    // 免费 token 可能提前失效：401 时换一个 token 重试一次
    if (response.status === 401) {
      cache.invalidate();
      headers.authorization = 'Bearer ' + (await cache.get(fetchFn, timeoutMs, deps.now));
      response = await requestJson(fetchFn, url.href, { method: 'POST', headers: headers, body: body }, timeoutMs, ENGINE_LABELS.microsoft);
    }

    if (response.status !== 200) {
      const failure = httpFailure('microsoft', response.status);
      return failed('microsoft', failure.message, failure.code);
    }
    const parsed = parseMicrosoftBody(response.json);
    if (parsed === null) return failed('microsoft', '微软翻译没有返回可用的译文', 'EMPTY_OUTPUT');
    return done('microsoft', parsed.text, { target: input.target, detected: parsed.detected, elapsedMs: Math.max(0, Date.now() - started), via: 'edge' });
  } catch (error) {
    if (error !== null && error !== undefined && error.code === 'TIMEOUT') return failed('microsoft', error.message, 'TIMEOUT');
    if (error !== null && error !== undefined && error.code === 'AUTH') return failed('microsoft', '微软取 token 失败：' + error.message, 'AUTH');
    const failure = networkFailure('microsoft', error);
    return failed('microsoft', failure.message, failure.code);
  }
}

/**
 * 从 Bing 翻译页里取"取数参数"。
 *
 * 页面里有两样东西必须拿到：
 *   · `params_AbusePreventionHelper = [<数字 key>, "<token>", <interval>]`
 *   · `IG:"<...>"`（请求头/查询串里的防滥用标识）
 * 拿不到就明确失败 —— 这比发一个必然被拒的请求好，因为错误里能告诉用户
 * "页面结构变了"，而不是一个莫名其妙的 401。
 */
export function parseBingParams(html) {
  if (typeof html !== 'string' || html === '') return null;
  const helper = /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"/.exec(html);
  if (helper === null) return null;
  const ig = /IG:"([^"]+)"/.exec(html);
  return { key: helper[1], token: helper[2], ig: ig === null ? '' : ig[1] };
}

/** 从响应里拼 Cookie 头（Node fetch 的 getSetCookie，缺了就当没有）。 */
export function cookieHeaderOf(response) {
  const headers = response === null || response === undefined ? undefined : response.headers;
  if (headers === null || headers === undefined) return '';
  let rows = [];
  try {
    if (typeof headers.getSetCookie === 'function') rows = headers.getSetCookie();
    else if (typeof headers.raw === 'function') {
      const raw = headers.raw();
      rows = raw === null || raw === undefined ? [] : raw['set-cookie'] ?? [];
    }
  } catch (error) {
    rows = [];
  }
  if (!Array.isArray(rows)) return '';
  return rows
    .map((row) => String(row).split(';')[0].trim())
    .filter((row) => row.includes('='))
    .join('; ');
}

/**
 * Bing 网页版取数参数的缓存。
 *
 * 为什么要缓存：每条翻译都要先抓一次翻译页才能拿到 key/token/IG，白多一个来回。
 * 页面里那个 helper 的第三个字段就是有效期（通常按小时计），这里保守地按 5 分钟算；
 * `ttranslatev3` 回 401/403 时强制失效并重试一次（token 提前过期是常见情况）。
 *
 * ⚠️ 与 `createMicrosoftTokenCache` 的区别：那个缓存的是 Bearer JWT，这个缓存的是
 * "页面参数 + Cookie"，两者绑定的通道不同，所以各自独立。
 */
export function createBingParamsCache() {
  let entry = null;
  let expiresAt = 0;
  return {
    /** 取一份可用参数（没过期就直接返回缓存）。 */
    async get(fetchFn, timeoutMs, now) {
      const clock = typeof now === 'function' ? now : () => Date.now();
      const current = clock();
      if (entry !== null && current < expiresAt) return entry;

      const page = await requestJson(
        fetchFn,
        BING_TRANSLATOR_URL,
        { method: 'GET', headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'text/html,application/xhtml+xml' } },
        timeoutMs,
        ENGINE_LABELS.microsoft,
      );
      if (page.status !== 200) {
        const failure = new Error('Bing 翻译页打不开（HTTP ' + page.status + '）');
        failure.code = httpFailure('microsoft', page.status).code;
        throw failure;
      }
      const params = parseBingParams(page.text);
      if (params === null) {
        const failure = new Error('Bing 翻译页里没有找到取数参数（页面结构可能变了）');
        failure.code = 'BING_PARAMS_MISSING';
        throw failure;
      }
      entry = { params: params, cookie: cookieHeaderOf(page) };
      expiresAt = current + 5 * 60 * 1000;
      return entry;
    },
    /** 标记失效（401/403 时用）。 */
    invalidate() {
      entry = null;
      expiresAt = 0;
    },
    /** 当前缓存内容（测试接缝）。 */
    peek() {
      return entry;
    },
  };
}

/** 打一次 Bing 的 ttranslatev3。 */
function bingTranslate(fetchFn, session, input, timeoutMs) {
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': DEFAULT_USER_AGENT,
    referer: BING_TRANSLATOR_URL,
    origin: BING_ORIGIN,
  };
  if (session.cookie !== '') headers.cookie = session.cookie;
  const body = new URLSearchParams({
    fromLang: sourceCodeFor('microsoft', input.source) === '' ? 'auto-detect' : sourceCodeFor('microsoft', input.source),
    text: input.text,
    to: languageCodeFor('microsoft', input.target),
    token: session.params.token,
    key: session.params.key,
  }).toString();
  const url = BING_TRANSLATE_URL + '?isVertical=1&IG=' + encodeURIComponent(session.params.ig) + '&IID=translator.5028.1';
  return requestJson(fetchFn, url, { method: 'POST', headers: headers, body: body }, timeoutMs, ENGINE_LABELS.microsoft);
}

/** Bing 网页版翻译。 */
async function runMicrosoftBing(input, deps) {
  const fetchFn = deps.fetch;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const started = Date.now();
  // ⚠️ 调用方应当传共享的 bingCache（路由就是这么做的），没传时按"本次调用"建一个
  const cache = deps.bingCache ?? createBingParamsCache();

  try {
    let session = await cache.get(fetchFn, timeoutMs, deps.now);
    let response = await bingTranslate(fetchFn, session, input, timeoutMs);

    // 页面参数可能提前失效：换一份再试一次
    if (response.status === 401 || response.status === 403) {
      cache.invalidate();
      session = await cache.get(fetchFn, timeoutMs, deps.now);
      response = await bingTranslate(fetchFn, session, input, timeoutMs);
    }

    if (response.status !== 200) {
      const failure = httpFailure('microsoft', response.status);
      return failed('microsoft', 'Bing 网页版：' + failure.message, failure.code);
    }
    const parsed = parseMicrosoftBody(response.json);
    if (parsed === null) return failed('microsoft', 'Bing 网页版没有返回可用的译文', 'EMPTY_OUTPUT');
    return done('microsoft', parsed.text, { target: input.target, detected: parsed.detected, elapsedMs: Math.max(0, Date.now() - started), via: 'bing' });
  } catch (error) {
    if (error !== null && error !== undefined && typeof error.code === 'string' && error.code !== 'THROWN') {
      return failed('microsoft', error.message, error.code);
    }
    const failure = networkFailure('microsoft', error);
    return failed('microsoft', failure.message, failure.code);
  }
}

/**
 * Google 翻译（免费端点或官方 v2）。
 *
 * ⚠️ 免费端点是 **GET**，文本进查询串，所以有长度上限：超过之后宁可明确失败
 * 也不要发一个会被网关截断的 URL。官方 v2 走 POST，没有这个问题。
 */
export async function runGoogle(input, deps) {
  const fetchFn = deps.fetch;
  const config = deps.config ?? {};
  const timeoutMs = deps.timeoutMs ?? 8000;
  const target = languageCodeFor('google', input.target);
  const started = Date.now();
  const key = typeof config.googleApiKey === 'string' ? config.googleApiKey : '';
  const useOfficial = key !== '';

  try {
    let response;
    const source = sourceCodeFor('google', input.source);
    if (useOfficial) {
      const url = new URL(GOOGLE_OFFICIAL_URL);
      url.searchParams.set('key', key);
      // 官方 v2 的源语言参数叫 source，留空即自动检测
      const payload = { q: input.text, target: target, format: 'text' };
      if (source !== '') payload.source = source;
      response = await requestJson(
        fetchFn,
        url.href,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': DEFAULT_USER_AGENT },
          body: JSON.stringify(payload),
        },
        timeoutMs,
        ENGINE_LABELS.google,
      );
    } else {
      const url = new URL(GOOGLE_FREE_URL);
      url.searchParams.set('client', 'gtx');
      url.searchParams.set('sl', source === '' ? 'auto' : source);
      url.searchParams.set('tl', target);
      url.searchParams.set('dj', '1');
      url.searchParams.set('dt', 't');
      url.searchParams.set('q', input.text);
      if (url.href.length > 7500) {
        return failed(
          'google',
          'Google 免费端点走 GET，这段文本太长（' + input.text.length + ' 字符）装不进 URL；换微软翻译或模型引擎，或给 Google 配官方 API key',
          'TEXT_TOO_LONG',
        );
      }
      response = await requestJson(fetchFn, url.href, { method: 'GET', headers: { 'user-agent': DEFAULT_USER_AGENT } }, timeoutMs, ENGINE_LABELS.google);
    }

    if (response.status !== 200) {
      const failure = httpFailure('google', response.status);
      return failed('google', failure.message, failure.code);
    }
    const parsed = parseGoogleBody(response.json);
    if (parsed === null) return failed('google', 'Google 翻译没有返回可用的译文', 'EMPTY_OUTPUT');
    return done('google', parsed.text, {
      target: input.target,
      detected: parsed.detected,
      elapsedMs: Math.max(0, Date.now() - started),
      official: useOfficial,
    });
  } catch (error) {
    if (error !== null && error !== undefined && error.code === 'TIMEOUT') return failed('google', error.message, 'TIMEOUT');
    const failure = networkFailure('google', error);
    return failed('google', failure.message, failure.code);
  }
}

// ----------------------------------------------------------------- 引擎目录与调度

/**
 * 引擎是否"配置齐全"：这两家免费模式永远可用，配了 key 就用官方端点。
 *
 * 微软的免费模式有两条通道（edge 端点 → Bing 网页版），这里报 `free`，
 * 具体走的哪条会出现在每次成功结果的 `via` 里（卡片上不显示，接口可见）。
 */
export function describeEngines(config) {
  const settings = config ?? {};
  return [
    {
      id: 'microsoft',
      label: ENGINE_LABELS.microsoft,
      available: true,
      mode: typeof settings.microsoftApiKey === 'string' && settings.microsoftApiKey !== '' ? 'azure' : 'free',
      channels: typeof settings.microsoftApiKey === 'string' && settings.microsoftApiKey !== '' ? ['azure'] : ['edge', 'bing'],
    },
    {
      id: 'google',
      label: ENGINE_LABELS.google,
      available: true,
      mode: typeof settings.googleApiKey === 'string' && settings.googleApiKey !== '' ? 'official' : 'free',
    },
    { id: 'llm', label: ENGINE_LABELS.llm, available: true, mode: 'host-route' },
  ];
}

/** 归一化顺序：只留已知 id、去重、非空；空则用默认顺序。 */
export function normalizeOrder(order) {
  const seen = new Set();
  const rows = [];
  if (Array.isArray(order)) {
    for (const id of order) {
      if (typeof id !== 'string' || ENGINE_LABELS[id] === undefined || seen.has(id)) continue;
      seen.add(id);
      rows.push(id);
    }
  }
  return rows.length > 0 ? rows : DEFAULT_ORDER.slice();
}

/**
 * 跑一个指定引擎。
 *
 * `llm` 走 engine.js 的模型路径（由 deps.runLlm 注入），另外两家走本文件。
 * 这样"引擎"这个概念只有一个入口，路由与回退逻辑都不需要分支。
 */
export async function runEngine(engineId, input, deps) {
  if (engineId === 'microsoft') return runMicrosoft(input, deps);
  if (engineId === 'google') return runGoogle(input, deps);
  if (engineId === 'llm') {
    if (typeof deps.runLlm !== 'function') {
      return failed('llm', '宿主没有可用的 llm 服务（本插件的宿主半侧没加载？）', 'NO_LLM_SERVICE');
    }
    const result = await deps.runLlm(input);
    if (result === null || result === undefined) return failed('llm', '模型引擎没有返回结果', 'EMPTY_OUTPUT');
    return Object.assign({}, result, { engine: { id: 'llm', label: ENGINE_LABELS.llm, model: result.engine?.model } });
  }
  return failed(engineId, '未知引擎：' + String(engineId), 'UNKNOWN_ENGINE');
}

/** 把一次尝试的失败浓缩成一句（自动模式的失败汇总用）。 */
function briefFailure(result) {
  const label = result.engine?.label ?? '未知引擎';
  const message = typeof result.error === 'string' ? result.error : '失败';
  const short = message.length > 80 ? message.slice(0, 80) + '…' : message;
  return label + '：' + short;
}

/**
 * 自动模式：按顺序尝试，第一个成功即返回。
 *
 * 失败时**把每一家的原因都列出来** —— "全都失败了"这句话没有信息量，
 * 而"微软：HTTP 429；Google：网络不可达；模型：额度用完"能直接告诉用户
 * 该修哪一条。
 *
 * 但**只有一个引擎时不做包装**：那会把 `NO_LLM_SERVICE` 这种精确、可执行的原因
 * 埋进一句概括里，调用方与卡片都失去了判断依据。
 */
export async function runAuto(input, deps) {
  const order = normalizeOrder(deps.order);
  const failures = [];
  let firstFailure = null;
  for (const id of order) {
    const result = await runEngine(id, input, deps);
    if (result.state === 'done') {
      return Object.assign({}, result, { attempts: failures.length === 0 ? undefined : failures.slice(), order: order });
    }
    if (firstFailure === null) firstFailure = result;
    failures.push(briefFailure(result));
  }
  if (order.length === 1 && firstFailure !== null) return Object.assign({}, firstFailure, { order: order });
  return {
    state: 'error',
    text: '',
    error: '所有引擎都失败了 —— ' + failures.join('；'),
    code: 'ALL_ENGINES_FAILED',
    cause: firstFailure === null ? undefined : firstFailure.code,
    engine: null,
    attempts: failures,
  };
}

/** 路由用的一次翻译入口：指定引擎或自动。 */
export async function runWithEngine(engineId, input, deps) {
  if (engineId === undefined || engineId === null || engineId === '' || engineId === 'auto') return runAuto(input, deps);
  const order = normalizeOrder(deps.order);
  if (ENGINE_LABELS[engineId] === undefined) {
    return failed('auto', '未知引擎：' + String(engineId) + '（可用：' + order.join(', ') + ', auto）', 'UNKNOWN_ENGINE');
  }
  if (!order.includes(engineId)) {
    // 显式指定一个不在顺序里的引擎是允许的（顺序只约束自动模式）
    return runEngine(engineId, input, deps);
  }
  const result = await runEngine(engineId, input, deps);
  if (result.state === 'done') return result;
  return Object.assign({}, result, { requested: engineId });
}

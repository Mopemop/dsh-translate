/**
 * dsh-translate 宿主半侧：给浏览器半侧提供一条翻译路由，并调度多个翻译引擎。
 *
 * ## 为什么翻译要放宿主
 *
 * 客户端半侧跑在页面里，页面 origin 是 `dsh-app://app`：模型凭据只允许宿主读取，
 * 而传统翻译端点（Google / 微软）都不带 CORS 头 —— 从页面直连一定被浏览器拦。
 * 所以三条引擎路径共用一条宿主路由：
 *
 *   卡片 ──POST/GET /dsh-translate/api/translate {text,target,engine}──► 本文件
 *                                                                        ├─ microsoft（默认首选）
 *                                                                        ├─ google
 *                                                                        └─ llm（ctx.llm.stream）
 *
 * 顺带三件事：结果在宿主侧缓存、超时与失败码在一处收口、key 永不进 DOM。
 *
 * ## 依赖
 *
 *   webServer           硬依赖（没有它就没有路由）
 *   llm                 软依赖：只在选到模型引擎时才需要，拿不到就如实失败
 *   agentDefaultModel   软依赖：模型引擎跟随用户在设置里选的默认模型
 *
 * ## 配置（写在 profile 的 cordis.patch.yml 里，改完重启生效）
 *
 *   - id: dsh-translate
 *     config:
 *       engines: ['microsoft', 'google', 'llm']   # 自动模式的顺序
 *       freeTimeoutMs: 8000                       # 传统引擎超时
 *       llmTimeoutMs: 30000                       # 模型引擎超时
 *       googleApiKey: ''                          # 填了就用 Cloud Translation v2
 *       microsoftApiKey: ''                       # 填了就用 Azure Translator
 *       microsoftRegion: ''                       # Azure 多区域资源需要
 *
 * 两个 key 也可以用环境变量给：DSH_TRANSLATE_GOOGLE_KEY / DSH_TRANSLATE_MICROSOFT_KEY
 * （+ DSH_TRANSLATE_MICROSOFT_REGION）。entry config 优先。
 *
 * ## 路由契约（客户端 src/client/translate.js 按同一张表调用）
 *
 *   GET  /dsh-translate/api/health    → { ok, version, hasLlm, providers[], selection, cacheSize, engines[], order[] }
 *   POST /dsh-translate/api/translate → TranslateResult（200 = done，502 = error）
 *        body: { text, target?, engine? }        engine: 'auto' | 'microsoft' | 'google' | 'llm'
 *   GET  /dsh-translate/api/translate?text=&target=&engine=   （桌面版非 GET 会被 SPA 兜底 405，见 README）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SOURCE, DEFAULT_TARGET, cacheKey, createCache, normalizeSource, normalizeTarget, runTranslation } from './engine.js';
import { DEFAULT_ORDER, createBingParamsCache, createMicrosoftTokenCache, describeEngines, normalizeOrder, runWithEngine } from './engines.js';

export const name = 'dsh-translate';

/** 只硬依赖 webServer；llm 与 agentDefaultModel 都按可选处理（见文件头）。 */
export const inject = ['webServer'];

/** 路由前缀（客户端拼同一个常量）。 */
export const ROUTE_PREFIX = '/dsh-translate/api';

/** 缓存条目上限。 */
export const CACHE_LIMIT = 200;

/** GET 运输方式的文本上限（见 README：桌面版非 GET 会被 SPA 兜底回答 405）。 */
export const GET_TEXT_LIMIT = 1500;

/**
 * 会话模型的缓存时长与条目上限。
 *
 * 为什么必须缓存：`sessionController.inspect()` 会把会话的事件日志（可能几千条）读出来，
 * 而划词翻译可能连着来好几次。60s 足够覆盖"连续划几个词"，用户换了模型最多 1 分钟生效
 * （也可以点卡片上的重试立刻再取一次）。
 */
export const SESSION_TTL_MS = 60 * 1000;
export const SESSION_CACHE_LIMIT = 50;

/**
 * 读会话状态的两档限时。
 *
 * ⚠️ 这两个数字是"防超时"的关键，不是随便定的：
 *   · **投影**（`projections()`）只读投影表，KB 级，3 秒足够；
 *   · **日志**（`inspect()`）会把整份事件日志读出来 —— 实测当前会话压缩后 5 MB、
 *     解压几十 MB，所以要限得很死（1.5 秒），拿不到就直接用全局默认模型。
 * 宁可退回默认模型，也不能让一次划词卡到超时。
 */
export const SESSION_READ_LIMIT_MS = 3000;
export const SESSION_EVENTS_LIMIT_MS = 1500;

/** 读失败后的短暂退避：避免每个请求都为同一个失败会话各等一次限时。 */
export const SESSION_FAIL_BACKOFF_MS = 5000;

/**
 * 带限时地调一次会话读取接口。
 *
 * 返回三种结果：拿到值 / 超时 / 抛错。**超时必须能区分出来** —— 这是"读太慢"
 * 与"读不到"两种原因的差别，前者要写进 /health 让人一眼看出是日志太大。
 */
async function readWithLimit(call, limitMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  let timedOut = false;
  const expired = Symbol('timeout');
  // ⚠️ 除了给 signal，**自己也要 race 计时器**：被调方不理会 signal 时，
  // 只靠 abort 会一直 await 下去 —— 那正是我们要修的超时。
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (controller !== null) controller.abort();
      resolve(expired);
    }, Math.max(1, limitMs));
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => call(controller === null ? undefined : controller.signal)), timeout]);
    if (value === expired) return { ok: false, timedOut: true };
    return { ok: true, value: value };
  } catch (error) {
    if (timedOut) return { ok: false, timedOut: true };
    return { ok: false, error: error };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 把任意错误变成一句可读的原因。 */
function describeFailure(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/**
 * 从会话投影里取"这个会话当前在用什么模型"。
 *
 * 投影 `modelSelection` 的形状（实测，来自会话投影缓存）：
 *   { lastUsed: { provider, model, reasoningEffort }, pending: null }
 * `pending` 是"刚选还没用上"的那次选择 —— 用户刚换模型时它才是最新意图，所以优先取它。
 * 另外兼容持久化包装 `{ ver, seq, val }`（万一接口给的是包装值）。
 */
export function modelFromProjections(values) {
  if (values === null || values === undefined || typeof values !== 'object') return null;
  const raw = values.modelSelection;
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const unwrapped = raw.val !== undefined && raw.val !== null ? raw.val : raw;
  const used = unwrapped.pending !== undefined && unwrapped.pending !== null ? unwrapped.pending : unwrapped.lastUsed !== undefined && unwrapped.lastUsed !== null ? unwrapped.lastUsed : unwrapped;
  if (used === null || used === undefined || typeof used !== 'object') return null;
  if (typeof used.provider !== 'string' || typeof used.model !== 'string' || used.provider === '' || used.model === '') return null;
  return { provider: used.provider, model: used.model };
}

/** 配置默认值。 */
export const DEFAULTS = {
  engines: DEFAULT_ORDER.slice(),
  freeTimeoutMs: 8000,
  // 45s：翻译本身可能带推理（会话默认是 high），30s 会把"慢但能成"的翻译掐成超时
  llmTimeoutMs: 45000,
  // 模型是否跟随"当前对话"（读会话投影里的 modelSelection）；关掉就一律用全局默认模型
  followSessionModel: true,
  googleApiKey: '',
  microsoftApiKey: '',
  microsoftRegion: '',
};

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 版本从 package.json 读，避免和客户端那行身份日志漂移。 */
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  } catch (error) {
    return '0.0.0';
  }
})();

function describe(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/** 数值配置的夹取。 */
function numberSetting(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** entry config + 环境变量 → 生效配置（entry config 优先）。 */
export function resolveConfig(raw, env) {
  const source = raw === null || raw === undefined || typeof raw !== 'object' ? {} : raw;
  const environment = env !== undefined ? env : typeof process !== 'undefined' && process.env !== undefined ? process.env : {};
  const text = (key, fallback) => (typeof source[key] === 'string' && source[key] !== '' ? source[key] : fallback);
  return {
    engines: normalizeOrder(source.engines),
    freeTimeoutMs: numberSetting(source.freeTimeoutMs, DEFAULTS.freeTimeoutMs, 1000, 30000),
    llmTimeoutMs: numberSetting(source.llmTimeoutMs, DEFAULTS.llmTimeoutMs, 5000, 120000),
    // 只有显式写 false 才关（"没写"= 默认跟随当前对话）
    followSessionModel: source.followSessionModel === false ? false : source.followSessionModel === true ? true : DEFAULTS.followSessionModel,
    googleApiKey: text('googleApiKey', environment.DSH_TRANSLATE_GOOGLE_KEY ?? ''),
    microsoftApiKey: text('microsoftApiKey', environment.DSH_TRANSLATE_MICROSOFT_KEY ?? ''),
    microsoftRegion: text('microsoftRegion', environment.DSH_TRANSLATE_MICROSOFT_REGION ?? ''),
  };
}

/**
 * 读取当前运行时可用的模型能力。
 *
 * 抽成函数是有意的：它把"从 ctx 取服务"这件只有真实 DSH 才能做的事，
 * 和"路由怎么响应"这件可以单测的事分开 —— 后者用注入的 describe() 驱动。
 */
export function describeRuntime(ctx) {
  const get = typeof ctx?.get === 'function' ? (key) => ctx.get(key) : () => undefined;
  const llm = get('llm');
  const defaults = get('agentDefaultModel');
  const sessionController = get('sessionController');

  let selection;
  if (defaults !== null && defaults !== undefined && typeof defaults.currentSelection === 'function') {
    try {
      selection = defaults.currentSelection();
    } catch (error) {
      selection = undefined;
    }
  }

  let providers = [];
  if (llm !== null && llm !== undefined && typeof llm.listProviders === 'function') {
    try {
      const rows = llm.listProviders();
      if (Array.isArray(rows)) {
        providers = rows.map((row) => (row === null || row === undefined ? undefined : row.id)).filter((id) => typeof id === 'string');
      }
    } catch (error) {
      providers = [];
    }
  }

  return { llm, selection, providers, sessionController };
}

/**
 * 从会话事件里解析"这个会话当前在用什么模型"。
 *
 * 为什么读事件日志：DSH 的文档写得很明确 —— 默认值只影响**之后**从它解析选择的 agent，
 * 而**已建立的会话沿用它请求日志里的那个选择**（这样改默认值不会打断已有的前缀缓存）。
 * 所以"当前对话在用什么模型"这件事，唯一权威的地方就是日志里的 `request/context` /
 * `request/header` 事件。
 *
 * 取**最后一条**：会话中途换过模型时，最后一条才是它现在的选择。
 */
export function modelFromSessionEvents(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === null || event === undefined) continue;
    const data = event.data;
    if (data === null || data === undefined) continue;
    // request/context: { provider, model, … } 最直接
    if (event.type === 'request/context' && typeof data.provider === 'string' && typeof data.model === 'string' && data.provider !== '' && data.model !== '') {
      return { provider: data.provider, model: data.model };
    }
    // request/header: { header: { config: { provider, model } }, reason }
    if (event.type === 'request/header') {
      const config = data.header === null || data.header === undefined ? undefined : data.header.config;
      if (config !== null && config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string' && config.provider !== '' && config.model !== '') {
        return { provider: config.provider, model: config.model };
      }
    }
  }
  return null;
}

/**
 * 建路由处理函数。
 *
 * @param deps.describe - () => { llm, selection, providers, sessionController? }（每次请求现取：模型设置可热改）
 * @param deps.config - resolveConfig 的结果
 * @param deps.cache - 结果缓存（默认新建）
 * @param deps.tokenCache - 微软 edge 通道的 token 缓存（默认新建）
 * @param deps.bingCache - 微软 Bing 网页版的页面参数缓存（默认新建）
 * @param deps.fetch - 出站 fetch（默认全局；测试注入假实现）
 * @param deps.version - /health 报的版本
 * @param deps.sessionTtlMs - 会话模型的缓存时长（默认 60s：读会话状态虽然便宜，但也没必要每次划词都读）
 * @param deps.sessionLimitsMs - { projection, events } 两次读取各自的限时（测试里调小）
 */
export function createRouteHandler(deps) {
  const options = deps ?? {};
  const cache = options.cache ?? createCache(CACHE_LIMIT);
  const config = options.config ?? resolveConfig(undefined);
  const tokenCache = options.tokenCache ?? createMicrosoftTokenCache();
  const bingCache = options.bingCache ?? createBingParamsCache();
  const fetchFn = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  const runtimeNow =
    typeof options.describe === 'function' ? options.describe : () => ({ llm: undefined, selection: undefined, providers: [] });
  const sessionTtlMs = typeof options.sessionTtlMs === 'number' && options.sessionTtlMs >= 0 ? options.sessionTtlMs : SESSION_TTL_MS;
  const limits = Object.assign({ projection: SESSION_READ_LIMIT_MS, events: SESSION_EVENTS_LIMIT_MS }, options.sessionLimitsMs ?? {});
  const sessionCache = new Map();
  // 最近一次实际用的模型来自哪里：/health 与启动日志都靠它自证
  let lastSelection = { source: 'default', provider: undefined, model: undefined, sessionId: null, reason: '' };

  /**
   * 解析这次翻译该用哪个模型：会话模型优先，读不到就用全局默认。
   *
   * ⚠️ 这里**绝对不能读整份会话日志**：实测当前会话的日志是 5 MB（zstd）→ 解压后几十 MB、
   * 几万条事件。`sessionController.inspect()` 把它们全读出来解析成对象交给我，足够把
   * 一次划词拖到超时（用户实测的"模型翻译超时"就是这么来的）。
   *
   * 所以顺序是：
   *   ① **投影**（首选）：`sessionController.projections()` 只读投影表，KB 级，
   *      其中 `modelSelection` 就是"这个会话当前在用什么模型"；
   *   ② **限时读日志**（兜底）：老版本没有投影时，才去读日志，而且只给 1.5 秒，
   *      超时就放弃（拿不到就用全局默认，翻译照常进行）；
   *   ③ 全局默认。
   *
   * 每一步都带 `AbortSignal` 限时：宁可退回默认模型，也不能让用户等。
   */
  async function selectionFor(sessionId, runtime) {
    const fallback = runtime === null || runtime === undefined ? undefined : runtime.selection;
    if (config.followSessionModel !== true) {
      lastSelection = { source: 'default', provider: fallback?.provider, model: fallback?.model, sessionId: sessionId === '' ? null : sessionId, reason: '配置里关掉了 followSessionModel' };
      return fallback;
    }
    if (typeof sessionId !== 'string' || sessionId === '') {
      lastSelection = { source: 'default', provider: fallback?.provider, model: fallback?.model, sessionId: null, reason: '请求里没有 sessionId' };
      return fallback;
    }

    const cached = sessionCache.get(sessionId);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < (cached.source === 'session' ? sessionTtlMs : SESSION_FAIL_BACKOFF_MS)) {
      lastSelection = { source: cached.source, provider: cached.selection?.provider, model: cached.selection?.model, sessionId, reason: cached.reason, via: cached.via };
      return cached.selection;
    }

    const controller = runtime === null || runtime === undefined ? undefined : runtime.sessionController;
    if (controller === null || controller === undefined) {
      lastSelection = { source: 'default', provider: fallback?.provider, model: fallback?.model, sessionId, reason: '宿主没有 sessionController' };
      return fallback;
    }

    const remember = (selection, source, reason, via) => {
      sessionCache.set(sessionId, { selection: selection, at: Date.now(), source: source, reason: reason, via: via });
      if (sessionCache.size > SESSION_CACHE_LIMIT) sessionCache.delete(sessionCache.keys().next().value);
      lastSelection = { source: source, provider: selection?.provider, model: selection?.model, sessionId: sessionId, reason: reason, via: via };
      return selection;
    };

    // ① 投影：只读投影表，便宜且就是权威值
    if (typeof controller.projections === 'function') {
      const projected = await readWithLimit(
        (signal) => controller.projections({ sessionId: sessionId }, signal),
        limits.projection,
      );
      if (projected.ok === true) {
        // 接口文档给的是 { asOfSeq, values }；这里也容一手"直接就是值表"的情形，
        // 免得上游换了包装就静默失效（静默失效正是这次 bug 的教训）
        const container = projected.value;
        const table = container !== null && container !== undefined && container.values !== undefined && container.values !== null ? container.values : container;
        const fromProjection = modelFromProjections(table);
        if (fromProjection !== null) return remember(fromProjection, 'session', '会话投影 modelSelection', 'projection');
      } else if (projected.timedOut === true) {
        return remember(fallback, 'default', '读会话投影超时（' + limits.projection + 'ms）', undefined);
      } else {
        const detail = describeFailure(projected.error);
        // 投影读失败不急着放弃：还有日志这条路（同样限时）
        var projectionFailure = detail;
      }
    }

    // ② 兜底：限时读日志（老版本 / 投影里没有这个键）
    if (typeof controller.inspect === 'function') {
      const inspection = await readWithLimit((signal) => controller.inspect(sessionId, signal), limits.events);
      if (inspection.ok === true) {
        const fromLog = modelFromSessionEvents(inspection.value === null || inspection.value === undefined ? undefined : inspection.value.events);
        if (fromLog !== null) return remember(fromLog, 'session', '会话请求日志', 'events');
        return remember(fallback, 'default', '会话里还没有模型记录', undefined);
      }
      if (inspection.timedOut === true) {
        return remember(fallback, 'default', '读会话日志超时（' + limits.events + 'ms，日志可能有几十 MB）', undefined);
      }
      var inspectionFailure = describeFailure(inspection.error);
    }

    const reason = inspectionFailure !== undefined ? '读取会话失败：' + inspectionFailure : projectionFailure !== undefined ? '读取会话投影失败：' + projectionFailure : '宿主没有可用的会话读取接口';
    return remember(fallback, 'default', reason, undefined);
  }

  return async function handle(method, url, body) {
    const parsed = new URL(typeof url === 'string' && url !== '' ? url : '/', 'http://localhost');
    const path = parsed.pathname.startsWith(ROUTE_PREFIX) ? parsed.pathname.slice(ROUTE_PREFIX.length) || '/' : parsed.pathname;

    if (method === 'GET' && (path === '/health' || path === '/')) {
      const runtime = runtimeNow();
      return {
        status: 200,
        obj: {
          ok: true,
          version: options.version ?? null,
          hasLlm: runtime.llm !== null && runtime.llm !== undefined,
          providers: runtime.providers ?? [],
          selection: runtime.selection ?? null,
          cacheSize: cache.size,
          engines: describeEngines(config),
          order: config.engines,
          timeouts: { free: config.freeTimeoutMs, llm: config.llmTimeoutMs },
          // A 方案的自证：模型到底跟的是"当前对话"还是"全局默认"，以及为什么
          sessionFollow: {
            enabled: config.followSessionModel === true,
            ttlMs: sessionTtlMs,
            limitsMs: { projection: limits.projection, events: limits.events },
            last: lastSelection,
          },
        },
      };
    }

    if ((method === 'POST' || method === 'GET') && path === '/translate') {
      // POST 走 JSON body；GET 走查询串（见 README 的 405 排查）
      const fromQuery = method === 'GET' ? parsed.searchParams.get('text') : null;
      const text = fromQuery !== null ? fromQuery : body !== null && body !== undefined && typeof body.text === 'string' ? body.text : undefined;
      if (text === undefined || text.trim() === '') {
        return { status: 400, obj: { state: 'error', error: '缺少待翻译文本（POST body.text 或 GET ?text=）', code: 'BAD_REQUEST' } };
      }
      if (method === 'GET' && text.length > GET_TEXT_LIMIT) {
        return {
          status: 413,
          obj: { state: 'error', error: '选区太长，GET 运输方式装不下（上限 ' + GET_TEXT_LIMIT + ' 字符）', code: 'TEXT_TOO_LONG_FOR_GET' },
        };
      }

      const target = normalizeTarget(
        method === 'GET' ? parsed.searchParams.get('target') ?? DEFAULT_TARGET : body === null || body === undefined ? DEFAULT_TARGET : body.target,
      );
      // 源语言：'auto'（默认，交给各引擎自己判断）或具体语言码。
      // 它与 target 分开传，因为卡片上是两个独立选择器。
      const source = normalizeSource(
        method === 'GET' ? parsed.searchParams.get('source') : body === null || body === undefined ? 'auto' : body.source,
      );
      /**
       * 会话 id：用来跟随"当前对话"的模型（A 方案）。
       *
       * 客户端从 DOM 上 `[data-sidebar-right-session]` 的值拿到它（DSH 自己也是这么读的）。
       * 拿不到就留空 —— 那就退回全局默认模型，功能不受影响。
       */
      const sessionRaw = method === 'GET' ? parsed.searchParams.get('sessionId') : body === null || body === undefined ? null : body.sessionId;
      const sessionId = typeof sessionRaw === 'string' && sessionRaw !== '' ? sessionRaw : '';
      const requested =
        method === 'GET'
          ? parsed.searchParams.get('engine') ?? 'auto'
          : body === null || body === undefined || body.engine === undefined
            ? 'auto'
            : body.engine;
      const engineId = typeof requested === 'string' && requested !== '' ? requested : 'auto';

      // 缓存键必须带上源语言：同一段文本、同一目标，但源语言不同时结果可能不同
      // （尤其"自动检测"会把中文误判成别的语言时要复现）
      const key = cacheKey(text, target, engineId, source);
      const hit = cache.get(key);
      if (hit !== undefined) return { status: 200, obj: { ...hit, cached: true } };

      if (fetchFn === undefined) {
        return { status: 502, obj: { state: 'error', error: '宿主没有可用的 fetch，无法调用翻译端点', code: 'NO_FETCH' } };
      }

      const runtime = runtimeNow();
      const result = await runWithEngine(
        engineId,
        { text: text, target: target, source: source },
        {
          fetch: fetchFn,
          config: config,
          order: config.engines,
          tokenCache: tokenCache,
          bingCache: bingCache,
          timeoutMs: config.freeTimeoutMs,
          // 惰性解析：只有链子真的走到模型这一路时才去读会话日志（微软成功时一次都不读）
          runLlm: async (input) => {
            const selection = await selectionFor(sessionId, runtime);
            return runTranslation(input, { llm: runtime.llm, selection: selection, timeoutMs: config.llmTimeoutMs });
          },
        },
      );
      if (result.state === 'done') cache.set(key, result);
      return { status: result.state === 'done' ? 200 : 502, obj: result };
    }

    return { status: 404, obj: { state: 'error', error: '未知路由：' + String(method) + ' ' + path, code: 'NOT_FOUND' } };
  };
}

/** 读请求体（有上限，避免被塞爆内存）。 */
async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 启动日志用的引擎描述。 */
function engineSummary(config) {
  const rows = describeEngines(config);
  return config.engines
    .map((id) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row === undefined) return id;
      return row.mode === 'free' ? row.label + '(免费端点)' : row.label + '(' + row.mode + ')';
    })
    .join(' → ');
}

function log(ctx, level, line) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-translate') : undefined;
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](line);
    else console.log(line);
  } catch (error) {
    console.log(line);
  }
}

/**
 * Cordis 插件体。
 * @param ctx - 宿主上下文（inject: webServer）
 * @param rawConfig - entry config（可省略）
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const cache = createCache(CACHE_LIMIT);
  const tokenCache = createMicrosoftTokenCache();
  const bingCache = createBingParamsCache();
  const handle = createRouteHandler({
    cache,
    config,
    tokenCache,
    bingCache,
    version: VERSION,
    describe: () => describeRuntime(ctx),
  });

  ctx.effect(
    () => {
      // 注册失败（例如同名 prefix 路由已被别的实例占用）不该让整个 fiber 失败：
      // 记一行日志就够了 —— 插件位还在，客户端会把"请求拿不到响应"如实显示出来。
      try {
        return ctx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            try {
              const body = req.method === 'POST' ? await readBody(req) : undefined;
              const result = await handle(req.method ?? 'GET', req.url ?? '/', body);
              sendJson(res, result.status, result.obj);
            } catch (error) {
              sendJson(res, 500, { state: 'error', error: describe(error), code: 'ROUTE_FAILURE' });
            }
          },
        });
      } catch (error) {
        log(ctx, 'warn', '[dsh-translate] 路由注册失败：' + describe(error));
        return () => {};
      }
    },
    'dsh-translate: /dsh-translate/api routes',
  );

  // 启动留两行身份：宿主有没有拿到 llm、默认模型是什么、引擎顺序与各自模式。
  // 这几件事决定翻译能不能用，放在启动日志里比让用户去翻 /health 友好。
  const runtime = describeRuntime(ctx);
  log(
    ctx,
    'info',
    '[dsh-translate] 宿主 v' +
      VERSION +
      ' · llm=' +
      (runtime.llm === null || runtime.llm === undefined ? '不可用' : '可用') +
      ' · 默认模型=' +
      (runtime.selection === null || runtime.selection === undefined
        ? '(未知，回落 deepseek-account/deepseek-flash)'
        : runtime.selection.provider + '/' + runtime.selection.model),
  );
  log(
    ctx,
    'info',
    '[dsh-translate] 引擎：' + engineSummary(config) + ' · 免费端点超时 ' + config.freeTimeoutMs + 'ms · 路由 ' + ROUTE_PREFIX,
  );
  log(
    ctx,
    'info',
    '[dsh-translate] 模型：' +
      (config.followSessionModel === true ? '跟随当前对话（读会话投影 modelSelection' + (runtime.sessionController === null || runtime.sessionController === undefined ? '，但宿主没有 sessionController → 只能回落全局默认' : '') + '）' : '只用全局默认（配置里关掉了 followSessionModel）') +
      ' · 模型超时 ' +
      config.llmTimeoutMs +
      'ms',
  );
}

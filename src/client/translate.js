/**
 * 翻译引擎接缝（客户端侧）—— 指向宿主路由，并处理"路由可能不存在"这件事。
 *
 * ## 链路
 *
 *   本文件 ──POST/GET /dsh-translate/api/translate──► 宿主 lib/index.js ──ctx.llm.stream──► 模型
 *
 * 为什么绕宿主：模型凭据只允许宿主读取（DeepSeek 账号凭据根本不下发到页面），
 * 而且宿主侧能缓存、能统一收口超时与失败码。
 *
 * ## 结果协议（UI 只认这三种 state）
 *
 *   { state: 'loading' }
 *   { state: 'done',  text, target, engine, usage, elapsedMs, cached? }
 *   { state: 'error', error, code }
 *
 * 任何失败（超时、断连、宿主没重启、模型额度）都必须收敛成 error 结果，
 * 不要把异常抛给卡片 —— 卡片只负责渲染，不负责错误处理。
 *
 * ## 为什么要处理"路由不存在"
 *
 * 桌面版的页面 origin 是 `dsh-app://app`，所有请求都经 Electron 协议处理器转发给
 * 宿主；而宿主里"没有匹配具名路由的非 GET/HEAD 请求"由 SPA 兜底回答 **405**。
 * 于是"宿主半侧没重新加载"这个最容易被误判成网络问题的故障，会长成 HTTP 405。
 * 这里把它识别出来，换成两句能直接照做的话（重启 DSH / 换 GET 运输），
 * 并在 GET 一路通的时候把它记下来。
 */

/** 宿主路由。 */
var API_PATH = '/dsh-translate/api/translate';

/** 宿主健康检查（用来区分"路由不存在"与"这次请求被拦"）。 */
var HEALTH_PATH = '/dsh-translate/api/health';

/** GET 运输方式的文本上限（与宿主侧 GET_TEXT_LIMIT 一致）。 */
var GET_TEXT_LIMIT = 1500;

/** 两种运输方式。 */
var TRANSPORT_POST = 'post';
var TRANSPORT_GET = 'get';

/**
 * 运输方式记忆：默认 POST；一旦某条路通了一次就记住它，后续不再先撞一次 POST。
 */
var transport = TRANSPORT_POST;

/**
 * 引擎选择。
 *
 * 顺序即"点一下引擎标签"的循环顺序，**第一家就是默认值**：
 * 用户明确说过"默认用微软翻译"，所以默认不是"自动"——
 * 自动模式在前一家失败时要等它超时（最坏 8s）才换下一家，那是"兜底"而不是"日常"。
 * `auto` 留在循环末尾，想开回退的人点两下就能切到。
 */
var ENGINE_CYCLE = ['microsoft', 'google', 'llm', 'auto'];

/** 没选过引擎时用它。 */
var DEFAULT_ENGINE = 'microsoft';

var ENGINE_LABELS = {
  microsoft: '微软翻译',
  google: 'Google 翻译',
  llm: '模型',
  auto: '自动',
};

/**
 * 偏好键：记住用户选过的引擎，下次划词直接用它。
 *
 * 带 `:2` 版本后缀是有意的：早期版本把"点一下循环下一个"的中间值也写进了这里，
 * 于是用户本来只想用默认值，却被一个过期的 `auto` 粘住（表现为每次划词都慢吞吞地
 * 依次尝试三家）。换键名等于把那些历史值一次性作废，回到当前默认值（微软翻译）。
 */
var ENGINE_STORAGE_KEY = 'dsh-translate:engine:2';

/** 读取引擎偏好（拿不到 localStorage 时回落默认引擎）。 */
function readEnginePreference() {
  try {
    var saved = localStorage.getItem(ENGINE_STORAGE_KEY);
    return saved !== null && ENGINE_LABELS[saved] !== undefined ? saved : DEFAULT_ENGINE;
  } catch (error) {
    return DEFAULT_ENGINE;
  }
}

/** 写入引擎偏好。失败就当没发生（隐私模式/存储被禁都只是"记不住"）。 */
function writeEnginePreference(engine) {
  try {
    if (ENGINE_LABELS[engine] === undefined) return;
    localStorage.setItem(ENGINE_STORAGE_KEY, engine);
  } catch (error) {
    /* 记不住不影响本次翻译 */
  }
}

/**
 * 语言偏好键与读写。
 *
 * 和引擎偏好同一个理由：用户手动选过的源语言/目标语言要记住，否则每次划词都得重选，
 * 这个选择器就白做了。读取时按白名单把关（历史值/手改的坏值一律回落默认）。
 */
var SOURCE_STORAGE_KEY = 'dsh-translate:source';
var TARGET_STORAGE_KEY = 'dsh-translate:target';

function readLanguagePreference(key, fallback, allowed) {
  try {
    var saved = localStorage.getItem(key);
    return saved !== null && allowed.indexOf(saved) !== -1 ? saved : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeLanguagePreference(key, value) {
  try {
    if (typeof value !== 'string' || value === '') return;
    localStorage.setItem(key, value);
  } catch (error) {
    /* 记不住不影响本次翻译 */
  }
}

/** 读源语言偏好（默认 auto = 自动检测）。 */
function readSourcePreference() {
  return readLanguagePreference(SOURCE_STORAGE_KEY, DEFAULT_SOURCE, SOURCE_LANGUAGES);
}

/** 写源语言偏好。 */
function writeSourcePreference(source) {
  writeLanguagePreference(SOURCE_STORAGE_KEY, source);
}

/** 读目标语言偏好（默认中文）。 */
function readTargetPreference() {
  return readLanguagePreference(TARGET_STORAGE_KEY, DEFAULT_TARGET, TARGET_LANGUAGES);
}

/** 写目标语言偏好。 */
function writeTargetPreference(target) {
  writeLanguagePreference(TARGET_STORAGE_KEY, target);
}

/** 循环到下一个引擎。 */
function nextEngine(engine) {
  var at = ENGINE_CYCLE.indexOf(engine);
  return ENGINE_CYCLE[(at + 1) % ENGINE_CYCLE.length];
}

/** 引擎显示名（认不出来就原样返回，便于排查配置写错的情况）。 */
function engineLabelOf(engine) {
  if (typeof engine !== 'string' || engine === '') return ENGINE_LABELS.auto;
  return ENGINE_LABELS[engine] !== undefined ? ENGINE_LABELS[engine] : engine;
}

/** 健康检查结果（只探一次）。 */
var routeProbe = null;

/**
 * 客户端超时。
 *
 * 必须**大于宿主侧的最坏耗时**，否则客户端先掐断，用户看到的是"超时"而不是
 * 真实的失败原因。宿主侧自动模式最坏情况 = 免费引擎 8s × 2 + 模型 30s = 46s，
 * 这里留到 60s。
 */
var REQUEST_TIMEOUT_MS = 60000;

/**
 * 语言表：源语言与目标语言共用一份标签。
 *
 * ⚠️ 这份表的**键集合必须与宿主侧 `lib/engine.js` 的 `LANGUAGE_NAMES` 一致**：
 * 客户端能选到、宿主认不出来的语言，模型那路会把未知代码写进提示词（更早的版本
 * 甚至静默回落成"简体中文"）。render.test.mjs 里有一条用例直接比对两边。
 *
 * 顺序 = 下拉里的顺序：中文、常见西方语言、其余按地区铺开。
 * 代码用 BCP-47 的常见写法，宿主再按引擎翻译成各自写法（微软要 zh-Hans / sr-Cyrl 等）。
 */
var LANGUAGE_LABELS = {
  'zh-CN': '中文',
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

/** 默认：自动检测 → 中文。 */
var DEFAULT_SOURCE = 'auto';
var DEFAULT_TARGET = 'zh-CN';

/** 源语言里的"自动"选项（它只是源语言的一种，不能当目标语言）。 */
var AUTO_SOURCE_LABEL = '自动检测';

/** 目标语言列表（顺序 = 表里的插入顺序，中文在最前）。 */
var TARGET_LANGUAGES = Object.keys(LANGUAGE_LABELS);

/** 源语言列表（多一个 auto）。 */
var SOURCE_LANGUAGES = ['auto'].concat(TARGET_LANGUAGES);

/** 语言显示名（认不出来就原样显示，便于排查）。 */
function languageLabelOf(code) {
  if (code === 'auto') return AUTO_SOURCE_LABEL;
  if (typeof code !== 'string' || code === '') return LANGUAGE_LABELS[DEFAULT_TARGET];
  return LANGUAGE_LABELS[code] !== undefined ? LANGUAGE_LABELS[code] : code;
}

/** 目标语言显示名。 */
function targetLabelOf(target) {
  if (typeof target !== 'string' || target === '' || target === 'auto') return LANGUAGE_LABELS[DEFAULT_TARGET];
  return languageLabelOf(target);
}

/** 源语言显示名。 */
function sourceLabelOf(source) {
  if (typeof source !== 'string' || source === '' || source === 'auto') return AUTO_SOURCE_LABEL;
  return languageLabelOf(source);
}

/** 构造"翻译中"结果。 */
function loadingResult(target) {
  return { state: 'loading', text: '', target: target, engine: null };
}

/** 构造错误结果（error 是给用户看的一句话，code 是给程序看的标识）。 */
function errorResult(target, message, code) {
  return { state: 'error', text: '', error: message, code: code, target: target, engine: null };
}

/** 把任意抛出的东西变成一句人话。 */
function describeError(error) {
  if (error === null || error === undefined) return '翻译失败';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/** 把宿主返回体收敛成结果协议。 */
function interpretResponse(status, body, target) {
  if (body === null || body === undefined || typeof body !== 'object') {
    return errorResult(target, '宿主返回了无法解析的响应（HTTP ' + String(status) + '）', 'BAD_RESPONSE');
  }
  if (body.state === 'done' && typeof body.text === 'string' && body.text !== '') {
    return {
      state: 'done',
      text: body.text,
      target: typeof body.target === 'string' && body.target !== '' ? body.target : target,
      engine: body.engine === undefined ? null : body.engine,
      usage: body.usage === undefined ? null : body.usage,
      elapsedMs: typeof body.elapsedMs === 'number' ? body.elapsedMs : null,
      cached: body.cached === true,
    };
  }
  var message = typeof body.error === 'string' && body.error !== '' ? body.error : '翻译失败';
  return errorResult(target, message, typeof body.code === 'string' ? body.code : 'HOST_ERROR');
}

/** 测试接缝：清掉运输方式与探测缓存。 */
function resetTransport() {
  transport = TRANSPORT_POST;
  routeProbe = null;
}

/** GET 运输是否装得下这段文本。 */
function canUseGet(text) {
  return typeof text === 'string' && text.length > 0 && text.length <= GET_TEXT_LIMIT;
}

/** 页面 origin（报错时带上，便于判断是哪种载体）。 */
function pageOrigin() {
  try {
    return typeof location === 'undefined' || location.origin === undefined ? '' : String(location.origin);
  } catch (error) {
    return '';
  }
}

/** 探一次宿主路由是否存在（GET /health 返回 JSON 才算存在）。 */
function probeRoute(fetchFn) {
  if (routeProbe === null) {
    routeProbe = fetchFn(HEALTH_PATH, { method: 'GET' }).then(
      function (response) {
        if (response === null || response === undefined || response.ok !== true) return false;
        return response.json().then(
          function (body) {
            return body !== null && typeof body === 'object' && body.ok === true;
          },
          function () {
            return false;
          },
        );
      },
      function () {
        return false;
      },
    );
  }
  return routeProbe;
}

/**
 * "路由不存在"的专用错误。
 *
 * 这段文案是刻意的：这个失败态最容易被误判成"网络问题"或"模型问题"，
 * 而实际根因几乎总是**宿主半侧没重新加载**（改了 lib/*.js 只刷新页面不够）。
 * 所以把该做的事直接写进错误里，并带上页面 origin。
 */
function routeMissingResult(target, status, probed) {
  var where = pageOrigin() === '' ? '' : '，页面 origin ' + pageOrigin();
  var reason = probed
    ? '宿主健康检查也不是 JSON（HTTP ' + String(status) + where + '）'
    : '宿主返回 HTTP ' + String(status) + where;
  return errorResult(
    target,
    '宿主路由 /dsh-translate/api 不存在：' + reason + '。改了 lib/*.js 之后必须重启 DSH —— 刷新页面只会换客户端产物，不会重新加载宿主半侧。',
    'NO_ROUTE',
  );
}

/**
 * 发一次请求。
 *
 * @returns Promise —— routeMiss 表示"这个响应看起来不是我们那条路由给的"
 *   （404 / 405 / 非 JSON 体），由调用方决定换运输方式还是报错。
 */
function sendOnce(fetchFn, text, target, mode, engine, source, sessionId) {
  var controller = typeof AbortController === 'function' ? new AbortController() : null;
  var timer =
    controller === null
      ? null
      : setTimeout(function () {
          controller.abort();
        }, REQUEST_TIMEOUT_MS);

  var url = API_PATH;
  // 源语言与目标语言都发（'auto' 表示让引擎自己检测）；
  // 有 sessionId 时一并带上 —— 宿主据此跟随"当前对话的模型"，没有就退回全局默认
  var payload = { text: text, target: target, engine: engine, source: source };
  if (typeof sessionId === 'string' && sessionId !== '') payload.sessionId = sessionId;
  var init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
  if (mode === TRANSPORT_GET) {
    url =
      API_PATH +
      '?text=' +
      encodeURIComponent(text) +
      '&target=' +
      encodeURIComponent(target) +
      '&engine=' +
      encodeURIComponent(engine) +
      '&source=' +
      encodeURIComponent(source);
    if (typeof sessionId === 'string' && sessionId !== '') url += '&sessionId=' + encodeURIComponent(sessionId);
    init = { method: 'GET' };
  }
  if (controller !== null) init.signal = controller.signal;

  return fetchFn(url, init)
    .then(
      function (response) {
        // 分两步取 body：宿主返回非 JSON（SPA 兜底的 405、网关页）时不能让链断掉
        return response.json().then(
          function (body) {
            return { status: response.status, body: body };
          },
          function () {
            return { status: response.status, body: null };
          },
        );
      },
      function (error) {
        if (controller !== null && controller.signal.aborted) return { aborted: true };
        return { unreachable: true, error: error };
      },
    )
    .then(
      function (outcome) {
        if (timer !== null) clearTimeout(timer);
        if (outcome.aborted === true) {
          return {
            routeMiss: false,
            result: errorResult(target, '翻译请求超时（' + Math.round(REQUEST_TIMEOUT_MS / 1000) + 's），可以重试', 'TIMEOUT'),
          };
        }
        if (outcome.unreachable === true) {
          return {
            routeMiss: false,
            result: errorResult(target, '宿主翻译路由不可达：' + describeError(outcome.error), 'UNREACHABLE'),
          };
        }
        return {
          routeMiss: outcome.status === 404 || outcome.status === 405 || outcome.body === null,
          status: outcome.status,
          result: interpretResponse(outcome.status, outcome.body, target),
        };
      },
      function (error) {
        if (timer !== null) clearTimeout(timer);
        return { routeMiss: false, result: errorResult(target, describeError(error), 'CLIENT_FAILURE') };
      },
    );
}

/**
 * 真正发起翻译。
 *
 * **永不 reject**：所有失败都收敛成 error 结果 —— 卡片只负责渲染，不负责错误处理。
 *
 * 运输方式策略：
 *   1. 先按记下来的方式发（默认 POST）；
 *   2. 响应看起来"不是我们那条路由给的"时，先 GET /health 探一次：
 *      · 路由在（health 是 JSON）而这次是 POST → 换 GET 重发一次，并记住这条路；
 *      · 路由不在 → 直接给出"要重启 DSH"的可执行错误，不再浪费第二次请求。
 *
 * @param input - { text: string, target?: string, source?: string }
 * @returns Promise<result>
 */
function requestTranslation(input) {
  var text = input !== null && input !== undefined && typeof input.text === 'string' ? input.text : '';
  var target =
    input !== null && input !== undefined && typeof input.target === 'string' && input.target !== '' ? input.target : readTargetPreference();
  var source =
    input !== null && input !== undefined && typeof input.source === 'string' && input.source !== '' ? input.source : readSourcePreference();
  var engine =
    input !== null && input !== undefined && typeof input.engine === 'string' && input.engine !== '' ? input.engine : readEnginePreference();
  // 会话 id：让宿主跟随"当前对话的模型"（拿不到就不带，退回全局默认）
  var sessionId = input !== null && input !== undefined && typeof input.sessionId === 'string' ? input.sessionId : '';

  var fetchFn = typeof fetch === 'function' ? fetch : null;
  if (fetchFn === null) return Promise.resolve(errorResult(target, '当前环境没有 fetch，无法调用宿主翻译路由', 'NO_FETCH'));

  function attempt(mode) {
    return sendOnce(fetchFn, text, target, mode, engine, source, sessionId).then(function (outcome) {
      if (outcome.routeMiss !== true) {
        transport = mode; // 这条路能通就记住，下次不再先撞一次 POST
        return outcome.result;
      }
      var status = outcome.status === undefined ? 0 : outcome.status;
      return probeRoute(fetchFn).then(function (alive) {
        if (alive === true) {
          if (mode === TRANSPORT_POST && canUseGet(text)) {
            transport = TRANSPORT_GET;
            return attempt(TRANSPORT_GET);
          }
          return errorResult(
            target,
            '宿主路由在，但这次请求拿不到响应（HTTP ' + String(status) + '）；选区过长时改用 GET，可缩短后重试',
            'ROUTE_REJECTED',
          );
        }
        return routeMissingResult(target, status, true);
      });
    });
  }

  return attempt(transport);
}

/**
 * 把引擎结果并进草稿。
 *
 * 抽成函数是为了让"过期结果"只有一个落点：结果回来时用户可能已经划了别的词
 * （甚至关掉了卡片），此时用函数式更新比对文本，不一致就原样返回。
 */
function mergeResult(draft, result) {
  return Object.assign({}, draft, { result: result });
}

return {
  API_PATH: API_PATH,
  HEALTH_PATH: HEALTH_PATH,
  GET_TEXT_LIMIT: GET_TEXT_LIMIT,
  TRANSPORT_POST: TRANSPORT_POST,
  TRANSPORT_GET: TRANSPORT_GET,
  ENGINE_CYCLE: ENGINE_CYCLE,
  ENGINE_LABELS: ENGINE_LABELS,
  DEFAULT_ENGINE: DEFAULT_ENGINE,
  REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
  LANGUAGE_LABELS: LANGUAGE_LABELS,
  SOURCE_LANGUAGES: SOURCE_LANGUAGES,
  TARGET_LANGUAGES: TARGET_LANGUAGES,
  DEFAULT_SOURCE: DEFAULT_SOURCE,
  DEFAULT_TARGET: DEFAULT_TARGET,
  AUTO_SOURCE_LABEL: AUTO_SOURCE_LABEL,
  languageLabelOf: languageLabelOf,
  sourceLabelOf: sourceLabelOf,
  targetLabelOf: targetLabelOf,
  readSourcePreference: readSourcePreference,
  writeSourcePreference: writeSourcePreference,
  readTargetPreference: readTargetPreference,
  writeTargetPreference: writeTargetPreference,
  loadingResult: loadingResult,
  errorResult: errorResult,
  describeError: describeError,
  interpretResponse: interpretResponse,
  resetTransport: resetTransport,
  canUseGet: canUseGet,
  sendOnce: sendOnce,
  readEnginePreference: readEnginePreference,
  writeEnginePreference: writeEnginePreference,
  nextEngine: nextEngine,
  engineLabelOf: engineLabelOf,
  requestTranslation: requestTranslation,
  mergeResult: mergeResult,
};

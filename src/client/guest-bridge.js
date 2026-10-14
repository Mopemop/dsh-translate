/**
 * 侧栏浏览器的选区桥。
 *
 * ## 为什么不能像文档预览那样直接读选区
 *
 * 侧栏浏览器里跑的是 **Electron `<webview>`**：它是独立渲染进程里的跨域 guest，
 * 宿主页面拿不到它的 DOM，也收不到它的 `selectionchange`。DSH 主进程还给这个 guest
 * 上了固定隔离策略（无 preload、sandbox、权限全拒），所以"往 guest 里塞脚本"这条路
 * 在插件层面是走不通的。
 *
 * ## 那这条桥是怎么通的
 *
 * 关键事实：**`executeJavaScript` 是 `<webview>` 元素自带的 API**（page 侧能力，
 * 不需要 preload、不需要改主进程）。而 `webviewTag` 对主窗口是开着的
 * （否则侧栏浏览器根本建不出 webview）。
 *
 * 于是通道是：
 *
 *   ┌─ 宿主页面（本插件）────────────────────────────────────────┐
 *   │  ① executeJavaScript(安装脚本) → 在 guest 里装监听          │
 *   │  ② 定时 executeJavaScript(取队列) ← guest 里排队的选区事件   │
 *   │  ③ guest 局部矩形 + webview 元素的宿主矩形 = 卡片落点        │
 *   └────────────────────────────────────────────────────────────┘
 *
 * 为什么用**轮询**而不是事件：guest 往宿主推消息只有 `ipc-message`（要 preload）
 * 和 `console-message`（依赖 Electron 版本的事件签名，且会把页面自己的 console
 * 一起带进来）。轮询只用 `executeJavaScript` 一个 API，跨版本稳定，而且
 * "安装脚本还在不在"这件事可以被显式回答（见 `stale` 分支）——导航后自动重装。
 *
 * 代价是每 400ms 一次本地调用：**只在真的存在 webview 元素且页面可见时才跑**，
 * 拿不到 webview 时连调用都不会发生。
 *
 * ## 坐标为什么要在宿主侧合成
 *
 * guest 报的是它自己视口里的坐标（CSS 像素）；卡片挂在宿主 frame 级浮层上，
 * 要的是宿主视口坐标。两者差一个"webview 元素的宿主矩形"，再乘 guest 的缩放系数
 * （用户在浏览器 tab 里 Ctrl+滚轮缩放过页面的话就不止 1）。合成放在这里，
 * 上游的 placeCard 只认宿主坐标，不需要知道 webview 的存在。
 */

/** 侧栏浏览器创建的 guest 元素上带的标记（由 sidebar-browser 客户端半侧写入）。 */
var WEBVIEW_SELECTOR = 'webview[data-sidebar-browser-frame="webview"]';

/**
 * 轮询间隔。
 *
 * 250ms 是"手感"与"开销"的折中：每次轮询只是一个本地 `executeJavaScript`
 * （亚毫秒级，不产生网络），但间隔直接决定"划完词到弹卡"的延迟 ——
 * 400ms 已经能感觉到一点点滞后，250ms 基本就是即时的。
 * 且只在**真的存在侧栏 webview 且页面可见**时才跑，空闲时连调用都没有。
 */
var POLL_INTERVAL_MS = 250;

/** guest 侧队列上限：宿主若长时间没轮询（标签页不可见），别让队列无限涨。 */
var MAX_QUEUE = 32;

/**
 * 装进 guest 的监听脚本。
 *
 * 三条设计约束：
 *   1. **幂等**：重复注入直接返回 'already'（重新注入不重复挂监听）；
 *   2. **不打扰**：只有在"曾经选中过东西"之后才推 clear —— 在浏览器页里随便点几下
 *      不该把文档预览那边的卡片关掉；
 *   3. **可判定存活**：安装标记挂在 `window` 上，导航后自然消失，
 *      宿主据此重装（见 GUEST_POLL_SCRIPT 的 stale 分支）。
 */
var GUEST_INSTALL_SCRIPT = [
  '(function () {',
  "  if (window.__dshTranslateInstalled === true) return 'already';",
  '  window.__dshTranslateInstalled = true;',
  '  var queue = [];',
  '  window.__dshTranslateQueue = queue;',
  '  var had = false;',
  '  var push = function (kind, payload) {',
  "    if (kind === 'clear' && !had) return;",
  "    if (kind === 'clear') had = false;",
  "    if (kind === 'pick') had = true;",
  '    if (queue.length >= ' + MAX_QUEUE + ') queue.splice(0, queue.length - ' + (MAX_QUEUE - 1) + ');',
  '    queue.push({',
  '      kind: kind,',
  "      text: payload && typeof payload.text === 'string' ? payload.text : '',",
  '      rect: payload && payload.rect ? payload.rect : null',
  '    });',
  '  };',
  '  var rectOf = function (range) {',
  '    var box = null;',
  '    try { box = range.getBoundingClientRect(); } catch (error) { box = null; }',
  '    if (!box || (box.width === 0 && box.height === 0)) {',
  '      try {',
  '        var rects = range.getClientRects();',
  '        if (rects && rects.length > 0) box = rects[0];',
  '      } catch (error) { /* 保持原值 */ }',
  '    }',
  '    if (!box) return { left: 0, top: 0, width: 0, height: 0 };',
  '    return { left: box.left || 0, top: box.top || 0, width: box.width || 0, height: box.height || 0 };',
  '  };',
  '  var read = function () {',
  '    timer = 0;',
  '    var selection = null;',
  '    try { selection = window.getSelection(); } catch (error) { selection = null; }',
  '    if (!selection || selection.isCollapsed === true || selection.rangeCount === 0) { push("clear", null); return; }',
  '    var text = "";',
  '    try { text = String(selection.toString() || ""); } catch (error) { text = ""; }',
  '    if (text.replace(/\\s+/g, "") === "") { push("clear", null); return; }',
  '    var range = null;',
  '    try { range = selection.getRangeAt(0); } catch (error) { range = null; }',
  '    push("pick", { text: text, rect: range ? rectOf(range) : { left: 0, top: 0, width: 0, height: 0 } });',
  '  };',
  '  var timer = 0;',
  '  var schedule = function () {',
  '    if (timer) { try { clearTimeout(timer); } catch (error) { timer = 0; } }',
  '    timer = setTimeout(read, 0);',
  '  };',
  '  document.addEventListener("mouseup", schedule, true);',
  '  document.addEventListener("keyup", function (event) {',
  '    if (event && event.key === "Escape") { if (had) push("clear", null); return; }',
  '    schedule();',
  '  }, true);',
  '  document.addEventListener("selectionchange", function () {',
  '    var selection = null;',
  '    try { selection = window.getSelection(); } catch (error) { selection = null; }',
  '    if (!selection || selection.isCollapsed === true) push("clear", null);',
  '  }, true);',
  "  return 'installed';",
  '})()',
].join('\n');

/**
 * 取队列的脚本。三种返回值，宿主据此分流：
 *   · `{ stale: true }` —— guest 里没有安装标记（导航过了 / 还没装）→ 重装；
 *   · `null`            —— 装了，但还没有事件；
 *   · `{ events: [...] }` —— 有事件，取走即清空（不会重复消费）。
 */
var GUEST_POLL_SCRIPT = [
  '(function () {',
  '  if (window.__dshTranslateInstalled !== true) return { stale: true };',
  '  var queue = window.__dshTranslateQueue;',
  '  if (!queue || queue.length === 0) return null;',
  '  return { events: queue.splice(0, queue.length) };',
  '})()',
].join('\n');

/** guest 视口坐标 → 宿主视口坐标。 */
function composeRect(elementRect, guestRect, zoom) {
  var factor = typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  var left = (elementRect.left || 0) + (guestRect.left || 0) * factor;
  var top = (elementRect.top || 0) + (guestRect.top || 0) * factor;
  var width = (guestRect.width || 0) * factor;
  var height = (guestRect.height || 0) * factor;
  return { left: left, top: top, width: width, height: height, right: left + width, bottom: top + height };
}

/**
 * 建桥。
 *
 * @param options.document - 宿主文档（用于找 webview 元素、看可见性）
 * @param options.window - 宿主窗口（提供 setInterval）
 * @param options.onPick - ({ text, truncated, rect }) => void，guest 里划完词
 * @param options.onClear - () => void，guest 里的选区被取消
 * @param options.onDiagnostic - (message) => void，能力缺失/注入失败等（只报不做）
 * @param options.intervalMs - 覆盖轮询间隔（测试用）
 */
function createGuestBridge(options) {
  var doc = options.document === undefined ? null : options.document;
  var win = options.window === undefined ? null : options.window;
  var entries = [];
  var timer = 0;
  var stopped = false;

  function report(message) {
    if (typeof options.onDiagnostic === 'function') options.onDiagnostic(message);
  }

  function elementsNow() {
    if (doc === null || typeof doc.querySelectorAll !== 'function') return [];
    var found;
    try {
      found = doc.querySelectorAll(WEBVIEW_SELECTOR);
    } catch (error) {
      return [];
    }
    var list = [];
    for (var i = 0; i < found.length; i++) list.push(found[i]);
    return list;
  }

  /** 取（或建）某个元素的桥状态；顺带丢掉已经离开 DOM 的旧条目。 */
  function entryFor(element) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].element === element) return entries[i];
    }
    var entry = { element: element, installed: false, lastText: null, warned: false };
    entries.push(entry);
    return entry;
  }

  function prune(live) {
    var kept = [];
    for (var i = 0; i < entries.length; i++) {
      var alive = false;
      for (var j = 0; j < live.length; j++) {
        if (live[j] === entries[i].element) alive = true;
      }
      if (alive) kept.push(entries[i]);
    }
    entries = kept;
  }

  function call(element, script) {
    if (element === null || element === undefined || typeof element.executeJavaScript !== 'function') {
      return Promise.reject(new Error('webview 元素不支持 executeJavaScript'));
    }
    try {
      return Promise.resolve(element.executeJavaScript(script));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function install(element, entry) {
    return call(element, GUEST_INSTALL_SCRIPT).then(
      function () {
        entry.installed = true;
      },
      function (error) {
        entry.installed = false;
        if (!entry.warned) {
          entry.warned = true;
          report('向侧栏浏览器注入选区监听失败：' + describe(error));
        }
      },
    );
  }

  function consume(element, entry, payload) {
    if (payload === null || payload === undefined) return;
    if (payload.stale === true) {
      // 导航过了（或首次尚未装）：下一轮重装
      entry.installed = false;
      return;
    }
    var events = payload.events;
    if (!isArray(events)) return;
    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      if (event === null || event === undefined) continue;
      if (event.kind === 'clear') {
        if (entry.lastText === null) continue;
        entry.lastText = null;
        options.onClear();
        continue;
      }
      if (event.kind !== 'pick') continue;
      var text = normalizeText(typeof event.text === 'string' ? event.text : '');
      if (text === '') continue;
      // 同一段文本连续上报（mouseup 与 selectionchange 都会触发）时只处理一次
      if (entry.lastText === text) continue;
      entry.lastText = text;
      var limited = clampText(text);
      // guest 的局部矩形要留着：卡片被"滚动的宿主"重新定位时，
      // 靠它 + webview 元素当前位置重新合成（见 anchor.js）
      var guestRect = flatRect(event.rect);
      var zoom = zoomFactorFor(element);
      options.onPick({
        text: limited.text,
        truncated: limited.truncated === true,
        rect: composeRect(elementRect(element), guestRect, zoom),
        anchor: guestAnchor(element, guestRect, zoom),
        // webview 所在的会话（右栏容器上的 data-sidebar-right-session）：
        // 浏览器 tab 里划词时，模型也该跟随当前对话
        sessionId: sessionIdOf(element),
        source: 'browser',
      });
    }
  }

  function poll(element, entry) {
    return call(element, GUEST_POLL_SCRIPT).then(
      function (payload) {
        consume(element, entry, payload);
      },
      function (error) {
        entry.installed = false;
        if (!entry.warned) {
          entry.warned = true;
          report('读取侧栏浏览器选区失败：' + describe(error));
        }
      },
    );
  }

  /** 一轮：找元素 → 该装的装 → 装好的取事件。 */
  function tick() {
    if (stopped) return;
    if (doc !== null && doc.visibilityState === 'hidden') return;
    var live = elementsNow();
    prune(live);
    for (var i = 0; i < live.length; i++) {
      var element = live[i];
      var entry = entryFor(element);
      if (!entry.installed) install(element, entry);
      else poll(element, entry);
    }
  }

  function start() {
    tick();
    if (win === null || typeof win.setInterval !== 'function') return;
    timer = win.setInterval(tick, typeof options.intervalMs === 'number' ? options.intervalMs : POLL_INTERVAL_MS);
  }

  function stop() {
    stopped = true;
    if (timer !== 0 && win !== null && typeof win.clearInterval === 'function') win.clearInterval(timer);
    timer = 0;
    entries = [];
  }

  return {
    start: start,
    stop: stop,
    tick: tick,
    entries: function () {
      return entries;
    },
  };
}

/** 任意矩形 → 四个有限数值（NaN/缺失一律归零）。 */
function flatRect(source) {
  if (source === null || source === undefined) return { left: 0, top: 0, width: 0, height: 0 };
  return {
    left: Number.isFinite(source.left) ? source.left : 0,
    top: Number.isFinite(source.top) ? source.top : 0,
    width: Number.isFinite(source.width) ? source.width : 0,
    height: Number.isFinite(source.height) ? source.height : 0,
  };
}

function isArray(value) {
  return Object.prototype.toString.call(value) === '[object Array]';
}

function describe(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

return {
  WEBVIEW_SELECTOR: WEBVIEW_SELECTOR,
  POLL_INTERVAL_MS: POLL_INTERVAL_MS,
  MAX_QUEUE: MAX_QUEUE,
  GUEST_INSTALL_SCRIPT: GUEST_INSTALL_SCRIPT,
  GUEST_POLL_SCRIPT: GUEST_POLL_SCRIPT,
  createGuestBridge: createGuestBridge,
};

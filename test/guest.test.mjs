/**
 * 侧栏浏览器选区桥的测试台。
 *
 * 这里最有价值的一点：**guest 侧的脚本是真的被求值执行的**。
 * `test/harness.mjs` 的 webview 桩会把 `executeJavaScript(code)` 的 code
 * 丢进一个假 guest 环境跑（有 window.getSelection、document.addEventListener、
 * setTimeout），所以下面这些断言验证的是"注入脚本 + 取值脚本 + 坐标合成"
 * 整条真实链路，而不是"某个函数返回了什么"。
 *
 * 覆盖的是浏览器 tab 特有的坑：
 *   · 导航后注入脚本随文档消失 → 必须能自己发现并重装；
 *   · 在页面里随便点几下不该把别处的卡片关掉；
 *   · 同一段文本被 mouseup 与 selectionchange 各报一次 → 只处理一次；
 *   · 页面缩放过（Ctrl+滚轮）时坐标要按系数缩放；
 *   · 拿不到 executeJavaScript 的 webview（换了实现）→ 报警一次而不是崩。
 */
import {
  loadBundle,
  check,
  summary,
  fakeDocument,
  fakeWindow,
  webviews as harnessWebviews,
  resetWebviews,
  flushIntervals,
  intervalCount,
  render,
  resetMount,
  textOf,
  byClass,
  findNode,
  listenerCount,
  resetListeners,
} from './harness.mjs';

const { api } = loadBundle();
const { createGuestBridge, composeRect, GUEST_INSTALL_SCRIPT, GUEST_POLL_SCRIPT, WEBVIEW_SELECTOR, POLL_INTERVAL_MS } = api;

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ----------------------------------------------------------------- 假 guest

/**
 * 一个够真的 guest 环境：注入脚本会在这里**真的被执行**。
 * 它只实现 guest 脚本用到的那点 API（getSelection / addEventListener / 定时器）。
 */
function makeGuest() {
  const listeners = new Map();
  const collapsed = { isCollapsed: true, rangeCount: 0, toString: () => '', getRangeAt: () => null };
  let current = collapsed;
  const guestWindow = { getSelection: () => current };
  const guestDocument = {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
  };
  return {
    window: guestWindow,
    /** 执行一段注入脚本：包在 return (...) 里，脚本是表达式形式的 IIFE。 */
    evaluate(code) {
      return new Function('window', 'document', 'setTimeout', 'clearTimeout', 'return (' + code + ');')(
        guestWindow,
        guestDocument,
        (fn) => {
          // 真实 guest 里是"下一个 tick"；这里同步跑，测试因此是确定性的
          fn();
          return 0;
        },
        () => {},
      );
    },
    fire(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    select(text, box) {
      current = {
        isCollapsed: false,
        rangeCount: 1,
        toString: () => text,
        getRangeAt: () => ({ getBoundingClientRect: () => box ?? rect(0, 0, 0, 0), getClientRects: () => [] }),
      };
    },
    collapse() {
      current = collapsed;
    },
    get installed() {
      return guestWindow.__dshTranslateInstalled === true;
    },
    get queue() {
      return guestWindow.__dshTranslateQueue ?? [];
    },
  };
}

function makeWebview(guest, options) {
  const opts = options ?? {};
  const element = {
    tagName: 'WEBVIEW',
    calls: [],
    box: opts.box ?? rect(600, 100, 400, 600),
    getBoundingClientRect: () => element.box,
    getZoomFactor: () => (opts.zoom === undefined ? 1 : opts.zoom),
    // webview 在右栏里时会挂在带 data-sidebar-right-session 的容器下
    // （宿主据此跟随"当前对话的模型"）
    getAttribute: (name) => (name === 'data-sidebar-right-session' && opts.sessionId !== undefined ? opts.sessionId : null),
    parentElement: null,
  };
  if (opts.noBridge !== true) {
    element.executeJavaScript = (code) => {
      element.calls.push(code);
      if (opts.fail === true) return Promise.reject(new Error('guest 尚未就绪'));
      return Promise.resolve(guest === null ? null : guest.evaluate(code));
    };
  }
  return element;
}

/** 起一个桥，收集回调。 */
function makeBridge(overrides) {
  const seen = { picks: [], clears: 0, diagnostics: [] };
  const bridge = createGuestBridge(
    Object.assign(
      {
        document: fakeDocument,
        window: fakeWindow,
        onPick: (picked) => seen.picks.push(picked),
        onClear: () => {
          seen.clears++;
        },
        onDiagnostic: (message) => seen.diagnostics.push(message),
      },
      overrides,
    ),
  );
  return { bridge, seen };
}

// ----------------------------------------------------------------- 坐标合成

check('合成：无缩放时就是 webview 矩形 + guest 矩形', (() => {
  const out = composeRect(rect(600, 100, 400, 600), rect(40, 60, 120, 16), 1);
  return out.left === 640 && out.top === 160 && out.width === 120 && out.height === 16 && out.right === 760 && out.bottom === 176;
})());
check('合成：缩放过页面时按系数缩放', (() => {
  const out = composeRect(rect(600, 100, 400, 600), rect(40, 60, 120, 16), 2);
  return out.left === 680 && out.top === 220 && out.width === 240 && out.height === 32;
})());
check('合成：非法缩放系数回落 1（不产生 NaN）', (() => {
  const a = composeRect(rect(0, 0, 10, 10), rect(5, 5, 5, 5), Number.NaN);
  const b = composeRect(rect(0, 0, 10, 10), rect(5, 5, 5, 5), -3);
  return a.left === 5 && b.left === 5;
})());
check('合成：缺字段当 0，不抛', (() => {
  const out = composeRect({}, {}, 1);
  return out.left === 0 && out.top === 0 && out.width === 0 && out.height === 0;
})());
check('选择器：只认 sidebar-browser 自己打的标记', WEBVIEW_SELECTOR === 'webview[data-sidebar-browser-frame="webview"]', WEBVIEW_SELECTOR);
check('轮询间隔：250ms 量级（够快又不至于空转）', POLL_INTERVAL_MS === 250, String(POLL_INTERVAL_MS));

// ----------------------------------------------------------------- 注入 → 取事件

{
  resetWebviews();
  resetListeners();
  const guest = makeGuest();
  const webview = makeWebview(guest);
  harnessWebviews.push(webview);
  const { bridge, seen } = makeBridge();

  bridge.start();
  check('启动：注册了轮询定时器（空闲时才没开销，有 webview 才忙）', intervalCount() === 1, String(intervalCount()));
  check('启动：第一轮就开始注入（不是等下一次轮询）', webview.calls.length === 1, String(webview.calls.length));
  await tick();
  check('注入：guest 里装上了标记与队列', guest.installed === true && Array.isArray(guest.queue), JSON.stringify({ installed: guest.installed, queue: guest.queue }));

  // guest 里划了一段话
  guest.select('Hello from the browser', rect(40, 60, 120, 16));
  guest.fire('mouseup');
  check('guest：划词事件排进了队列', guest.queue.length === 1 && guest.queue[0].kind === 'pick', JSON.stringify(guest.queue));

  flushIntervals();
  await tick();
  check('桥：把 guest 事件取走并上报', seen.picks.length === 1 && seen.picks[0].text === 'Hello from the browser', JSON.stringify(seen.picks.map((row) => row.text)));
  check('桥：队列已清空（不会重复消费）', guest.queue.length === 0, String(guest.queue.length));
  check(
    '桥：坐标已合成到宿主视口（webview 600,100 + guest 40,60）',
    seen.picks[0].rect.left === 640 && seen.picks[0].rect.top === 160 && seen.picks[0].rect.width === 120,
    JSON.stringify(seen.picks[0].rect),
  );
  check('桥：标注了来源（浏览器），便于区分两条来源', seen.picks[0].source === 'browser', String(seen.picks[0].source));

  // 同一段文本被 mouseup 与 selectionchange 各报一次：只处理一次
  guest.fire('mouseup');
  flushIntervals();
  await tick();
  check('去重：同一段文本连续上报只处理一次', seen.picks.length === 1, String(seen.picks.length));

  // 换一段文本
  guest.select('another sentence', rect(10, 20, 80, 16));
  guest.fire('mouseup');
  flushIntervals();
  await tick();
  check('去重：换了文本要如实上报', seen.picks.length === 2 && seen.picks[1].text === 'another sentence', String(seen.picks.length));

  // 取消选区 → 收起
  guest.collapse();
  guest.fire('selectionchange');
  flushIntervals();
  await tick();
  check('取消：guest 里取消选区会上报 clear', seen.clears === 1, String(seen.clears));

  // 取消之后又在别处点几下：不该反复上报 clear
  guest.fire('selectionchange');
  flushIntervals();
  await tick();
  check('取消：没有选中过的空白点击不再上报（不打扰别处的卡片）', seen.clears === 1, String(seen.clears));

  bridge.stop();
  check('停止：定时器摘干净', intervalCount() === 0, String(intervalCount()));
}

// ----------------------------------------------------------------- 空白点击不打扰

{
  resetWebviews();
  const guest = makeGuest();
  const webview = makeWebview(guest);
  harnessWebviews.push(webview);
  const { bridge, seen } = makeBridge();
  bridge.start();
  await tick();

  // 从没选中过东西，只是在页面里点了几下
  guest.fire('selectionchange');
  guest.fire('selectionchange');
  flushIntervals();
  await tick();
  check('未选中过时：队列里没有任何事件', guest.queue.length === 0, JSON.stringify(guest.queue));
  check('未选中过时：不会上报 clear', seen.clears === 0, String(seen.clears));
  bridge.stop();
}

// ----------------------------------------------------------------- 导航后自动重装

{
  resetWebviews();
  const first = makeGuest();
  const webview = makeWebview(first);
  harnessWebviews.push(webview);
  const { bridge, seen } = makeBridge();
  bridge.start();
  await tick();
  check('重装：首次注入成功', first.installed === true);
  const callsAfterInstall = webview.calls.length;

  // 模拟导航：guest 换了一个文档（注入脚本随之消失）
  const second = makeGuest();
  webview.executeJavaScript = (code) => {
    webview.calls.push(code);
    return Promise.resolve(second.evaluate(code));
  };
  flushIntervals();
  await tick();
  check('重装：发现 guest 里标记没了（stale）', webview.calls.length === callsAfterInstall + 1, `calls=${webview.calls.length}`);
  flushIntervals();
  await tick();
  check('重装：下一轮把脚本装回去', second.installed === true);
  check('重装：重装的是安装脚本而不是取值脚本', webview.calls[webview.calls.length - 1].includes('__dshTranslateInstalled = true'));

  second.select('after navigation', rect(10, 10, 50, 10));
  second.fire('mouseup');
  flushIntervals();
  await tick();
  check('重装：导航之后照样能划词上报', seen.picks.length === 1 && seen.picks[0].text === 'after navigation', JSON.stringify(seen.picks.map((row) => row.text)));
  bridge.stop();
}

// ----------------------------------------------------------------- 能力缺失 / 失败

{
  resetWebviews();
  const guest = makeGuest();
  harnessWebviews.push(makeWebview(guest, { noBridge: true }));
  const { bridge, seen } = makeBridge();
  bridge.start();
  await tick();
  check('缺失能力：没有 executeJavaScript 时报警一次', seen.diagnostics.length === 1 && seen.diagnostics[0].includes('executeJavaScript'), JSON.stringify(seen.diagnostics));
  flushIntervals();
  await tick();
  check('缺失能力：不会每轮重复刷同一条警告', seen.diagnostics.length === 1, String(seen.diagnostics.length));
  bridge.stop();
}

{
  resetWebviews();
  const guest = makeGuest();
  harnessWebviews.push(makeWebview(guest, { fail: true }));
  const { bridge, seen } = makeBridge();
  bridge.start();
  await tick();
  check('注入失败：上报一次诊断且不抛', seen.diagnostics.length === 1, JSON.stringify(seen.diagnostics));
  flushIntervals();
  await tick();
  check('注入失败：下一轮会重试（失败不是终态）', seen.diagnostics.length === 1);
  bridge.stop();
}

// ----------------------------------------------------------------- 可见性与元素生命周期

{
  resetWebviews();
  const guest = makeGuest();
  const webview = makeWebview(guest);
  harnessWebviews.push(webview);
  const { bridge } = makeBridge();
  bridge.start();
  await tick();
  const before = webview.calls.length;

  fakeDocument.visibilityState = 'hidden';
  flushIntervals();
  await tick();
  check('可见性：文档隐藏时不做任何调用', webview.calls.length === before, `${before} → ${webview.calls.length}`);
  fakeDocument.visibilityState = 'visible';
  flushIntervals();
  await tick();
  check('可见性：恢复可见后继续工作', webview.calls.length > before, `${before} → ${webview.calls.length}`);

  check('生命周期：跟踪着这个 webview', bridge.entries().length === 1, String(bridge.entries().length));
  resetWebviews();
  flushIntervals();
  await tick();
  check('生命周期：元素离开 DOM 后不再跟踪它', bridge.entries().length === 0, String(bridge.entries().length));
  bridge.stop();
}

// ----------------------------------------------------------------- 队列上限

{
  resetWebviews();
  const guest = makeGuest();
  harnessWebviews.push(makeWebview(guest));
  const { bridge } = makeBridge();
  bridge.start();
  await tick();
  for (let i = 0; i < 60; i++) {
    guest.select('text ' + i, rect(1, 1, 2, 2));
    guest.fire('mouseup');
  }
  check('上限：guest 队列不会无限涨（最多 32 条）', guest.queue.length <= 32 && guest.queue.length > 0, String(guest.queue.length));
  bridge.stop();
}

// ----------------------------------------------------------------- 与卡片的接线（浏览器来源）

{
  resetWebviews();
  resetListeners();
  resetMount(api.TranslateOverlay);
  const guest = makeGuest();
  const webview = makeWebview(guest, { box: rect(600, 100, 400, 600) });
  harnessWebviews.push(webview);

  let tree = render(api.TranslateOverlay, {});
  check('接线：初始没有卡片', tree === null, JSON.stringify(tree));
  await tick();
  check('接线：浮层挂载时就把桥接上了（浏览器 tab 存在即注入）', guest.installed === true);

  guest.select('Browser selection text', rect(40, 60, 120, 16));
  guest.fire('mouseup');
  flushIntervals();
  await tick();
  tree = render(api.TranslateOverlay, {});
  const card = findNode(tree, (node) => node.props?.['data-translate-card'] === 'card');
  check('接线：浏览器里划词后卡片出现', card !== null);
  check('接线：卡片里是浏览器页里选中的原文', textOf(byClass(tree, 'dst-source')) === 'Browser selection text', textOf(byClass(tree, 'dst-source')));
  // 选区在宿主视口里是 { left: 640, top: 160, width: 120, height: 16 }
  // → 卡片水平居中于选区：640 + 60 - 340/2 = 530；贴选区下方：160 + 16 + 10 = 186
  check(
    '接线：卡片落在宿主视口里（webview 600,100 + guest 40,60 合成后居中贴下方）',
    card?.props?.style?.left === '530px' && card?.props?.style?.top === '186px',
    JSON.stringify(card?.props?.style),
  );

  await tick();
  tree = render(api.TranslateOverlay, {});
  check('接线：引擎落地后进入 done 态', findNode(tree, (node) => node.props?.['data-translate-card'] === 'card')?.props?.['data-state'] === 'done');

  guest.collapse();
  guest.fire('selectionchange');
  flushIntervals();
  await tick();
  tree = render(api.TranslateOverlay, {});
  check('接线：浏览器里取消选区后卡片收起', tree === null, JSON.stringify(tree));
}

// ----------------------------------------------------------------- 注入脚本的形态约束

check('脚本：安装脚本是表达式形式的 IIFE（可直接被 executeJavaScript 求值）', GUEST_INSTALL_SCRIPT.trim().startsWith('(function ()') && GUEST_INSTALL_SCRIPT.trim().endsWith('})()'));
check('脚本：取值脚本同样是 IIFE', GUEST_POLL_SCRIPT.trim().startsWith('(function ()') && GUEST_POLL_SCRIPT.trim().endsWith('})()'));
check('脚本：不含 import/export（guest 侧是普通脚本环境）', /^\s*(import|export)\s/m.test(GUEST_INSTALL_SCRIPT) === false && /^\s*(import|export)\s/m.test(GUEST_POLL_SCRIPT) === false);
check('脚本：安装是幂等的（重复注入直接返回 already）', GUEST_INSTALL_SCRIPT.includes("if (window.__dshTranslateInstalled === true) return 'already';"));
check('脚本：取值脚本能区分"没装"与"没事件"', GUEST_POLL_SCRIPT.includes('stale: true') && GUEST_POLL_SCRIPT.includes('return null'));

// 浏览器 tab 里的选区也要带上会话 id（模型同样跟随当前对话）
{
  resetWebviews();
  const guest = makeGuest();
  harnessWebviews.push(makeWebview(guest, { sessionId: 'sess-web' }));
  const { bridge, seen } = makeBridge();
  bridge.start();
  await tick();
  guest.select('browser text', rect(10, 20, 100, 14));
  guest.fire('mouseup');
  flushIntervals();
  await tick();
  check('会话：浏览器 tab 的选区带着 sessionId（宿主据此跟随当前对话的模型）', seen.picks[0]?.sessionId === 'sess-web', JSON.stringify(seen.picks[0]?.sessionId));
  bridge.stop();
}
summary('侧栏浏览器选区桥');

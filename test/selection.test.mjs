/**
 * 选区判决与监听器时序的单测。
 *
 * 这里盯的是四个"只有真实页面才会暴露"的坑（见 selection.js 头注释）：
 * 该弹的不弹、不该弹的弹了、点卡片把卡片点没了、滚一下卡片跑到别处。
 * 事件时序用测试台自己的 timer 队列驱动，所以"mouseup 之后的下一个 tick"
 * 是可控的，不依赖真实计时。
 */
import { loadBundle, check, summary, fakeDocument, fakeWindow, fire, flushTimers, pendingTimers, resetListeners, setSelection, listenerCount, captureFlags } from './harness.mjs';

const { api } = loadBundle();
const { captureDraft, isInSidebar, isInsideElement, elementOfNode, SCOPE_QUERY, SCOPE_SELECTORS, createWatcher, MAX_TEXT_CHARS } = api;

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

/** 假元素：closest 只对右侧栏那几个属性有反应，模拟真实的"在/不在右栏"。 */
const sidebarElement = { nodeType: 1, closest: (query) => (query.includes('[data-sidebar-right-session]') ? { tag: 'panel' } : null) };
const floatElement = { nodeType: 1, closest: (query) => (query.includes('[data-dockkit-float]') ? { tag: 'float' } : null) };
const mainElement = { nodeType: 1, closest: () => null };
const textNodeIn = (parent) => ({ nodeType: 3, parentElement: parent });

function selectionOf(options) {
  const opts = options ?? {};
  const anchorNode = opts.anchorNode === undefined ? sidebarElement : opts.anchorNode;
  return {
    isCollapsed: opts.collapsed === true,
    rangeCount: opts.rangeCount === undefined ? 1 : opts.rangeCount,
    toString: () => (opts.text === undefined ? 'hello world' : opts.text),
    anchorNode: anchorNode,
    focusNode: opts.focusNode === undefined ? anchorNode : opts.focusNode,
    getRangeAt: () => ({ getBoundingClientRect: () => opts.rect ?? rect(120, 300, 200, 18), getClientRects: () => [] }),
  };
}

function draftEnv(overrides) {
  return Object.assign(
    {
      selection: selectionOf({}),
      isInSidebar: isInSidebar,
      isInsidePopup: () => false,
      rectOfRange: api.rectOfRange,
      normalizeText: api.normalizeText,
      clampText: api.clampText,
    },
    overrides,
  );
}

// ----------------------------------------------------------------- 作用域判据

check('作用域：四个抓手都在（右栏根 / 停靠面板 / 浮动面板 / tab 容器）', SCOPE_SELECTORS.length === 4, JSON.stringify(SCOPE_SELECTORS));
check(
  '作用域：合并选择器包含全部抓手',
  SCOPE_SELECTORS.every((one) => SCOPE_QUERY.includes(one)),
  SCOPE_QUERY,
);
check('作用域：右栏内的元素命中', isInSidebar(sidebarElement) === true);
check('作用域：浮动面板命中（它不在右栏根里面）', isInSidebar(floatElement) === true);
check('作用域：对话区的元素不命中', isInSidebar(mainElement) === false);
check('作用域：没有 closest 能力的节点不命中（不抛异常）', isInSidebar({ nodeType: 1 }) === false);
check('作用域：null 不命中', isInSidebar(null) === false);
check('作用域：closest 抛异常时判为不命中', isInSidebar({ nodeType: 1, closest: () => { throw new Error('bad selector'); } }) === false);

check('元素：文本节点往上取一层', elementOfNode(textNodeIn(sidebarElement)) === sidebarElement);check('元素：元素节点用它自己', elementOfNode(sidebarElement) === sidebarElement);
check('元素：没有父节点的文本节点返回 null', elementOfNode({ nodeType: 3, parentElement: undefined }) === null);
check('包含判定：容器自身算包含', isInsideElement(sidebarElement, sidebarElement) === true);
check('包含判定：contains 为真算包含', isInsideElement({ nodeType: 1 }, { contains: () => true }) === true);
check('包含判定：容器为 null 时为假（不抛）', isInsideElement(sidebarElement, null) === false);

// 侧栏矩形：卡片边界要用它（否则卡片会越出侧栏到对话区，那部分点不动）
{
  const panel = { nodeType: 1, getBoundingClientRect: () => rect(700, 60, 320, 520) };
  const inPanel = { nodeType: 1, closest: (query) => (query.includes('[data-sidebar-right-session]') ? panel : null) };
  const rect9 = api.sidebarRectOf(inPanel);
  check('侧栏矩形：能取到侧栏根的矩形', rect9 !== null && rect9.left === 700 && rect9.width === 320, JSON.stringify(rect9));
  check('侧栏矩形：不在侧栏里返回 null（调用方退回整窗）', api.sidebarRectOf(mainElement) === null);
  check('侧栏矩形：没有 closest 能力的节点返回 null（不抛）', api.sidebarRectOf({ nodeType: 1 }) === null && api.sidebarRectOf(null) === null);
  check('侧栏矩形：匹配元素没有矩形能力时返回 null', api.sidebarRectOf({ nodeType: 1, closest: () => ({ nodeType: 1 }) }) === null);
  check(
    '侧栏矩形：没有侧栏根时退到最近的容器（浮动面板等）',
    (() => {
      const float = { nodeType: 1, getBoundingClientRect: () => rect(100, 100, 400, 300) };
      const element = { nodeType: 1, closest: (query) => (query.includes('[data-dockkit-float]') ? float : null) };
      const out = api.sidebarRectOf(element);
      return out !== null && out.left === 100 && out.width === 400;
    })(),
  );
  check('侧栏矩形：矩形抛错时返回 null（不连累渲染）', api.sidebarRectOf({ nodeType: 1, closest: () => ({ nodeType: 1, getBoundingClientRect: () => { throw new Error('boom'); } }) }) === null);
}

// ----------------------------------------------------------------- captureDraft

check('判决：没有选区 → 不弹', captureDraft(draftEnv({ selection: null })) === null);
check('判决：选区塌陷（只是光标）→ 不弹', captureDraft(draftEnv({ selection: selectionOf({ collapsed: true }) })) === null);
check('判决：没有 range → 不弹', captureDraft(draftEnv({ selection: selectionOf({ rangeCount: 0 }) })) === null);
check('判决：纯空白 → 不弹', captureDraft(draftEnv({ selection: selectionOf({ text: '   \n\t ' }) })) === null);
check('判决：选区在卡片自己身上 → 不弹（不能自己弹自己）', captureDraft(draftEnv({ isInsidePopup: () => true })) === null);
check(
  '判决：选区不在右栏 → 不弹（对话区划词不打扰）',
  captureDraft(draftEnv({ selection: selectionOf({ anchorNode: mainElement }) })) === null,
);
check(
  '判决：anchorNode 是文本节点时按父元素判定作用域',
  captureDraft(draftEnv({ selection: selectionOf({ anchorNode: textNodeIn(sidebarElement) }) })) !== null,
);
check(
  '判决：anchorNode 取不到父元素时回落到 focusNode',
  captureDraft(draftEnv({ selection: selectionOf({ anchorNode: { nodeType: 3, parentElement: undefined }, focusNode: sidebarElement }) })) !== null,
);

{
  const draft = captureDraft(draftEnv({ selection: selectionOf({ text: '  第一行   \n\n\n\n第二行  ' }) }));
  check('判决：正常路径产出草稿', draft !== null && typeof draft.text === 'string');
  check('判决：文本被规整', draft.text === '第一行\n\n第二行', JSON.stringify(draft.text));
  check('判决：带上选区矩形', draft.rect.left === 120 && draft.rect.top === 300 && draft.rect.width === 200);
  check('判决：默认没有被截断', draft.truncated === false);
  check('判决：带上命中的元素（将来做"按文件类型配色"要用）', draft.element === sidebarElement);
}
{
  const draft = captureDraft(draftEnv({ selection: selectionOf({ text: 'x'.repeat(MAX_TEXT_CHARS + 500) }) }));
  check('判决：超长选区被截断并置标记', draft.text.length === MAX_TEXT_CHARS && draft.truncated === true, `len=${draft.text.length}`);
}

// ----------------------------------------------------------------- 监听器时序

function makeWatcher(overrides) {
  const calls = { picks: [], clears: 0 };
  const options = Object.assign(
    {
      document: fakeDocument,
      window: fakeWindow,
      onPick: (draft) => calls.picks.push(draft),
      onClear: () => {
        calls.clears++;
      },
      getPopupElement: () => null,
    },
    overrides,
  );
  const watcher = createWatcher(options);
  watcher.start();
  return { watcher, calls };
}

/** 当前登记在测试台上的监听器总数（用来验证 stop 摘干净了）。 */
const WATCHED_TYPES = ['mouseup', 'mousedown', 'keyup', 'keydown', 'selectionchange', 'scroll', 'resize'];
const activeListeners = () => WATCHED_TYPES.reduce((sum, type) => sum + listenerCount(type), 0);

{
  resetListeners();
  setSelection(selectionOf({ text: '选中了一段话' }));
  const { watcher, calls } = makeWatcher();
  fire('mouseup');
  check('时序：mouseup 不当场读选区（推到下一个 tick）', calls.picks.length === 0 && pendingTimers() === 1, `picks=${calls.picks.length} timers=${pendingTimers()}`);
  flushTimers();
  check('时序：一个 tick 之后弹出草稿', calls.picks.length === 1 && calls.picks[0].text === '选中了一段话', JSON.stringify(calls.picks.map((row) => row.text)));
  check('时序：正常弹出时不触发收起', calls.clears === 0, String(calls.clears));
  watcher.stop();
  check('时序：stop 之后没有待跑 timer，监听器也摘干净', pendingTimers() === 0 && activeListeners() === 0, `timers=${pendingTimers()} listeners=${activeListeners()}`);
}

{
  resetListeners();
  setSelection(selectionOf({ anchorNode: mainElement }));
  const { watcher, calls } = makeWatcher();
  fire('mouseup');
  flushTimers();
  check('时序：选区不在右栏 → 收起（而不是弹）', calls.picks.length === 0 && calls.clears === 1, `picks=${calls.picks.length} clears=${calls.clears}`);
  watcher.stop();
}

{
  resetListeners();
  setSelection(selectionOf({ collapsed: true }));
  const { watcher, calls } = makeWatcher();
  fire('mouseup');
  flushTimers();
  check('时序：只是点了下光标（塌陷）→ 收起', calls.picks.length === 0 && calls.clears === 1);
  watcher.stop();
}

{
  resetListeners();
  setSelection(selectionOf({}));
  const { watcher, calls } = makeWatcher();
  fire('mousedown', { target: mainElement });
  check('时序：在别处按下鼠标立刻收起（不等 mouseup）', calls.clears === 1, String(calls.clears));
  watcher.stop();
}

{
  resetListeners();
  const popupChild = { nodeType: 1 };
  const popup = { contains: (element) => element === popupChild };
  setSelection(selectionOf({}));
  const { watcher, calls } = makeWatcher({ getPopupElement: () => popup });

  fire('mousedown', { target: popupChild });
  check('时序：在卡片内部按下不收起（否则按钮点不到）', calls.clears === 0, String(calls.clears));

  // 真实浏览器里这次按下会把文档选区塌陷掉，于是 selectionchange 会来一发
  fire('selectionchange');
  setSelection(selectionOf({ collapsed: true }));
  fire('selectionchange');
  check('时序：卡片内的塌陷被忽略（guard 生效）', calls.clears === 0 && watcher.isPopupGuarded() === true, `clears=${calls.clears}`);

  fire('mouseup');
  flushTimers();
  check('时序：guard 期间不重新弹卡片', calls.picks.length === 0 && calls.clears === 0, `picks=${calls.picks.length} clears=${calls.clears}`);

  fire('mousedown', { target: mainElement });
  check('时序：在卡片外按下时 guard 复位并收起', calls.clears === 1 && watcher.isPopupGuarded() === false, `clears=${calls.clears}`);
  watcher.stop();
}

{
  resetListeners();
  setSelection(selectionOf({}));
  const { watcher, calls } = makeWatcher();
  fire('keyup', { key: 'Escape' });
  check('时序：Escape 收起卡片', calls.clears === 1);
  fire('keyup', { key: 'ArrowRight' });
  flushTimers();
  check('时序：Shift+方向键这类键盘选区也会触发', calls.picks.length === 1, `picks=${calls.picks.length}`);
  watcher.stop();
}

{
  resetListeners();
  setSelection(selectionOf({}));
  const { watcher, calls } = makeWatcher();
  setSelection(selectionOf({ collapsed: true }));
  fire('selectionchange');
  check('时序：选区被外部清空 → 收起', calls.clears === 1);
  fire('scroll');
  check('时序：滚动 → 收起（锚点会漂，不如不显示）', calls.clears === 2);
  fire('resize');
  check('时序：改窗口大小 → 收起', calls.clears === 3);
  watcher.stop();
}

{
  resetListeners();
  setSelection(selectionOf({}));
  const { watcher, calls } = makeWatcher();
  fire('mouseup');
  watcher.stop();
  flushTimers();
  check('时序：stop 会取消待跑的 tick（不会迟到地弹出来）', calls.picks.length === 0 && calls.clears === 0, `picks=${calls.picks.length}`);
}

// 视口变化：卡片内滚动绝不能关掉卡片；外部滚动优先"重新定位"
{
  resetListeners();
  const popupChild = { nodeType: 1 };
  const popup = { contains: (element) => element === popupChild };
  setSelection(selectionOf({}));
  const reanchors = [];
  const { watcher, calls } = makeWatcher({
    getPopupElement: () => popup,
    reanchor: () => {
      reanchors.push(1);
      return true;
    },
  });

  fire('scroll', { target: popupChild });
  check(
    '滚动：卡片内部滚动不收起（原文/译文区都可滚，这就是真 bug 的根因）',
    calls.clears === 0 && reanchors.length === 0,
    `clears=${calls.clears} reanchor=${reanchors.length}`,
  );

  fire('scroll', { target: { nodeType: 1 } });
  check('滚动：外部滚动优先重新定位而不是收起', reanchors.length === 1 && calls.clears === 0, `clears=${calls.clears} reanchor=${reanchors.length}`);

  fire('resize', {});
  check('缩放：改窗口大小同样走重新定位', reanchors.length === 2 && calls.clears === 0, `clears=${calls.clears} reanchor=${reanchors.length}`);
  watcher.stop();
}

{
  // 锚点算不出来（选区被删 / webview 被卸载）才收起
  resetListeners();
  setSelection(selectionOf({}));
  const { watcher, calls } = makeWatcher({ reanchor: () => false });
  fire('scroll', { target: { nodeType: 1 } });
  check('滚动：锚点失效时收起卡片', calls.clears === 1, String(calls.clears));
  watcher.stop();
}

{
  // 重新定位里抛错不能连累监听器
  resetListeners();
  setSelection(selectionOf({}));
  const { watcher, calls } = makeWatcher({
    reanchor: () => {
      throw new Error('boom');
    },
  });
  let threw = null;
  try {
    fire('scroll', { target: { nodeType: 1 } });
  } catch (error) {
    threw = error;
  }
  check('滚动：重新定位抛错时不崩，并按"锚点失效"收起', threw === null && calls.clears === 1, threw === null ? `clears=${calls.clears}` : threw.message);
  watcher.stop();
}

{
  // 没有重新定位能力时保持旧行为（老调用方的兜底）
  resetListeners();
  setSelection(selectionOf({}));
  const { watcher, calls } = makeWatcher();
  fire('scroll', {});
  check('滚动：没有重新定位能力时退回"收起"', calls.clears === 1, String(calls.clears));
  watcher.stop();
}

{
  // 按帧合并：一次滚动风暴只量一次布局（不然滚动会真的卡）
  resetListeners();
  setSelection(selectionOf({}));
  const frames = [];
  const originalRaf = fakeWindow.requestAnimationFrame;
  fakeWindow.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  let moved = 0;
  const { watcher } = makeWatcher({
    reanchor: () => {
      moved++;
      return true;
    },
  });
  for (let i = 0; i < 20; i++) fire('scroll', { target: { nodeType: 1 } });
  check('滚动：20 次滚动事件只排一帧（按帧合并）', frames.length === 1 && moved === 0, `frames=${frames.length} moved=${moved}`);
  frames[0]();
  check('滚动：帧回调只重新定位一次', moved === 1, String(moved));
  fakeWindow.requestAnimationFrame = originalRaf;
  watcher.stop();
}

// 拖到侧栏外松手：mouseup 可能被外面的元素吞掉，所以必须用捕获阶段 + 选区稳定兜底
{
  resetListeners();
  setSelection(selectionOf({ text: 'drag out of sidebar' }));
  const { watcher, calls } = makeWatcher();

  check('时序：mouseup 用捕获阶段（外面的元素 stopPropagation 也收得到）', captureFlags('mouseup').every((flag) => flag === true), JSON.stringify(captureFlags('mouseup')));
  check('时序：mousedown 仍在捕获阶段（卡片内按钮吞事件也看得到）', captureFlags('mousedown').every((flag) => flag === true), JSON.stringify(captureFlags('mousedown')));

  // 只发 selectionchange（模拟 mouseup 被吞掉）：等选区稳定后仍然取词
  resetListeners();
  setSelection(selectionOf({ text: 'no mouseup reached us' }));
  const settled = makeWatcher();
  fire('selectionchange');
  check('兜底：selectionchange 后先不急着弹（用户可能还在拖）', settled.calls.picks.length === 0, String(settled.calls.picks.length));
  flushTimers();
  check('兜底：选区稳定 180ms 后取词（覆盖 mouseup 被吞 / 键盘选区）', settled.calls.picks.length === 1, JSON.stringify(settled.calls.picks.map((row) => row.text)));
  settled.watcher.stop();

  // 右键松手不算划词结束
  resetListeners();
  setSelection(selectionOf({ text: 'right click' }));
  const right = makeWatcher();
  fire('mouseup', { button: 2 });
  flushTimers();
  check('时序：非主键（右键）的 mouseup 不取词', right.calls.picks.length === 0, String(right.calls.picks.length));
  fire('mouseup', { button: 0 });
  flushTimers();
  check('时序：主键 mouseup 照常取词', right.calls.picks.length === 1, String(right.calls.picks.length));
  right.watcher.stop();

  // 去重：mouseup 与 selectionchange 都来一遍，不能重复取词（否则会重新翻译一次）
  resetListeners();
  setSelection(selectionOf({ text: 'pick me once' }));
  const once = makeWatcher();
  fire('mouseup');
  flushTimers();
  fire('selectionchange');
  flushTimers();
  check('去重：mouseup + selectionchange 只取一次词（否则白翻译一遍、卡片闪一下）', once.calls.picks.length === 1, String(once.calls.picks.length));

  // 收起后再选同一段文本，仍要能弹（去重不能把正常重复划词也挡掉）
  fire('mousedown', { target: { nodeType: 1 } });
  check('去重：点别处会收起', once.calls.clears === 1, String(once.calls.clears));
  fire('mouseup');
  flushTimers();
  check('去重：收起后再选同一段文本仍然会弹', once.calls.picks.length === 2, String(once.calls.picks.length));
  once.watcher.stop();

  // stop 要把待定的"稳定"定时器也清掉
  resetListeners();
  setSelection(selectionOf({ text: 'stop me' }));
  const stopping = makeWatcher();
  const beforeSettle = pendingTimers();
  fire('selectionchange');
  check('兜底：selectionchange 会排一个稳定定时器', pendingTimers() > beforeSettle, `${beforeSettle} → ${pendingTimers()}`);
  stopping.watcher.stop();
  check('stop：清掉待定的稳定定时器', pendingTimers() === 0, String(pendingTimers()));
  flushTimers();
  check('stop：停了之后不该再取词', stopping.calls.picks.length === 0, String(stopping.calls.picks.length));
  watcher.stop();
}

summary('选区判决与监听器时序');

/**
 * 作用域判定：这次选区**该不该**弹卡片。
 *
 * ## 为什么必须限定作用域
 *
 * 卡片挂在 frame 级浮层（shell.overlay）上，位置来自「视口坐标的选区矩形」——
 * 也就是说，只要不做判定，**对话区里划词也会弹**。这不是我们想要的行为：
 * 对话区选文本是"我要复制这段"的常态操作，每次都被卡片打断很烦。
 *
 * ## 判据为什么是这几个 data 属性
 *
 * 右侧栏的 DOM 事实（这些属性由 DSH 自己写在元素上，属于跨版本最稳定的抓手）：
 *   · `[data-sidebar-right-session]` —— 右栏面板根（docked 模式包裹所有 pane）
 *   · `[data-dockkit-pane]`           —— dockkit 的一个停靠面板
 *   · `[data-dockkit-float]`          —— 浮起来的那个面板（**不在上面那个根里面**，
 *                                        所以必须单独列，否则浮动模式下判定失效）
 *   · `[data-sidebar-right-tab]`      —— 单个 tab 的内容容器
 *
 * 判据是"命中任一祖先"，不是"必须命中根"：浮动面板与未来的布局调整都不会漏。
 * 代价是这些属性名若被上游改名，判定会静默失效（表现为"划词不弹了"）——
 * 所以 `SCOPE_SELECTORS` 是导出常量，插件热修时改一处即可，并且有单测钉住它。
 */

var SCOPE_SELECTORS = [
  '[data-sidebar-right-session]',
  '[data-dockkit-pane]',
  '[data-dockkit-float]',
  '[data-sidebar-right-tab]',
];

/** 合并成一个选择器，`closest` 一次问完（比逐个问快，也少一次 DOM 往返）。 */
var SCOPE_QUERY = SCOPE_SELECTORS.join(',');

/**
 * 从选区端点拿到元素。
 *
 * 选区端点通常是文本节点，而 `closest` 只存在于 Element 上，
 * 所以必须往上取一层；端点直接是元素（例如选中一段整体）时就用它本身。
 */
function elementOfNode(node) {
  if (node === null || node === undefined) return null;
  if (node.nodeType === 1) return node;
  var parent = node.parentElement;
  return parent === undefined ? null : parent;
}

/** 元素是否落在右侧栏内。 */
function isInSidebar(element) {
  if (element === null || element === undefined || typeof element.closest !== 'function') return false;
  try {
    return element.closest(SCOPE_QUERY) !== null;
  } catch (error) {
    // 选择器被上游改坏时不要连累整个监听器
    return false;
  }
}

/** 元素是否在某个容器内（用于"选区落在卡片自己身上"的排除）。 */
function isInsideElement(element, container) {
  if (element === null || element === undefined || container === null || container === undefined) return false;
  if (container === element) return true;
  if (typeof container.contains !== 'function') return false;
  try {
    return container.contains(element) === true;
  } catch (error) {
    return false;
  }
}

/**
 * 把当前选区变成一份"待翻译草稿"，或判定为不该弹（返回 null）。
 *
 * 依赖全部由 `env` 注入，所以这一整段决策可以在 Node 里用假选区跑完：
 *   env.selection        当前 Selection（或 null）
 *   env.isInSidebar      (element) => boolean
 *   env.isInsidePopup    (element) => boolean
 *   env.rectOfRange      (range) => rect
 *   env.normalizeText    (raw) => string
 *   env.clampText        (text) => { text, truncated }
 *
 * 判决顺序有意为之：先排除"自己弹自己"，再判作用域，最后才算几何 ——
 * 几何是三者里最贵的（强制布局），不该为注定被丢弃的选区付这个钱。
 */
function captureDraft(env) {
  var selection = env.selection;
  if (selection === null || selection === undefined) return null;
  if (selection.isCollapsed === true) return null;
  var rangeCount = typeof selection.rangeCount === 'number' ? selection.rangeCount : 0;
  if (rangeCount <= 0) return null;

  var raw = typeof selection.toString === 'function' ? selection.toString() : '';
  var normalized = env.normalizeText(raw);
  if (normalized === '') return null;

  var element = elementOfNode(selection.anchorNode);
  if (element === null) element = elementOfNode(selection.focusNode);
  if (element === null) return null;

  // ① 选区落在卡片自己身上（用户选中了译文）——不能再弹一张
  if (env.isInsidePopup(element)) return null;
  // ② 不在右侧栏内（对话区、左栏）——按当前产品口径不处理
  if (!env.isInSidebar(element)) return null;

  var limited = env.clampText(normalized);
  var range = typeof selection.getRangeAt === 'function' ? selection.getRangeAt(0) : null;
  return {
    text: limited.text,
    truncated: limited.truncated === true,
    rect: env.rectOfRange(range),
    element: element,
    // 原始 Range 一并带出去：宿主滚动后卡片要重新定位，靠它重算落点
    // （克隆发生在 anchor.js，这里只负责把真值传下去）
    range: range,
    // 这段选区属于哪个会话 —— 宿主据此跟随"当前对话的模型"
    sessionId: sessionIdOf(element),
  };
}

/**
 * 这个元素属于哪个会话。
 *
 * DSH 在右侧栏容器上写了 `data-sidebar-right-session="<sessionId>"`（它的客户端代码
 * 用的就是 `dataset.sidebarRightSession`），所以这里顺着同一个契约往上找。
 * 拿到 sessionId 之后，宿主能用 `sessionController.inspect()` 读出**当前对话在用什么
 * 模型**，让翻译跟随它；找不到就返回空串 → 退回全局默认模型。
 */
function sessionIdOf(element) {
  var node = element === null || element === undefined ? null : element;
  var guard = 0;
  while (node !== null && node !== undefined && guard < 64) {
    guard++;
    if (typeof node.getAttribute === 'function') {
      var value = null;
      try {
        value = node.getAttribute('data-sidebar-right-session');
      } catch (error) {
        value = null;
      }
      if (typeof value === 'string' && value !== '') return value;
    }
    node = node.parentElement === undefined ? null : node.parentElement;
  }
  return '';
}

/**
 * 侧栏的矩形 —— 卡片必须夹在这块区域里。
 *
 * 为什么需要：卡片挂在 frame 级浮层上，若只按**整窗**夹取，靠近侧栏边缘的选区
 * 会把卡片推到对话区上方，那部分既盖住了别的区域、又点不动（用户实测的现象）。
 * 所以边界取"侧栏根"；没有侧栏根（浮动面板等）就退到最近的容器。
 *
 * 返回普通矩形对象（不是 DOMRect），调用方拿去做交集即可；拿不到返回 null。
 */
function sidebarRectOf(element) {
  if (element === null || element === undefined || typeof element.closest !== 'function') return null;
  var target = null;
  try {
    // 优先侧栏根：它才是用户眼里的"侧栏范围"
    target = element.closest('[data-sidebar-right-session]');
    if (target === null) target = element.closest(SCOPE_QUERY);
  } catch (error) {
    target = null;
  }
  if (target === null || target === undefined || typeof target.getBoundingClientRect !== 'function') return null;
  var box = null;
  try {
    box = target.getBoundingClientRect();
  } catch (error) {
    box = null;
  }
  if (box === null || box === undefined) return null;
  return {
    left: Number.isFinite(box.left) ? box.left : 0,
    top: Number.isFinite(box.top) ? box.top : 0,
    width: Number.isFinite(box.width) ? box.width : 0,
    height: Number.isFinite(box.height) ? box.height : 0,
  };
}

return {
  SCOPE_SELECTORS: SCOPE_SELECTORS,
  SCOPE_QUERY: SCOPE_QUERY,
  elementOfNode: elementOfNode,
  isInSidebar: isInSidebar,
  isInsideElement: isInsideElement,
  sessionIdOf: sessionIdOf,
  sidebarRectOf: sidebarRectOf,
  captureDraft: captureDraft,
};

/**
 * 选区锚点：让卡片在滚动 / 改窗口大小时**跟着选区走**，而不是一滚就消失。
 *
 * ## 为什么需要单独一层
 *
 * 两种选区来源的锚点形态完全不同：
 *
 *   · **文档预览**：一个活在 DOM 里的 `Range`。滚动之后 `getBoundingClientRect()`
 *     自己就更新了 —— 只要在捕获时**克隆**一份，用户的后续操作改不到它。
 *   · **侧栏浏览器**：guest 报的局部矩形 + 宿主里的 webview 元素 + guest 缩放系数。
 *     滚动之后要重新合成（元素位置变了，guest 内部的相对位置没变）。
 *
 * 于是监听器那边只需要问一句"还能算出来吗"：算不出来（选区被删、webview 被卸载）
 * 才收起卡片。这样"为了读更多内容而滚动"不会再误杀弹窗。
 *
 * ⚠️ 这里用 `isConnected === false` 判断"锚点是否已经离开 DOM"，而不是判断
 * "矩形是不是全 0" —— 后者会误伤宽度为 0 的正常选区（例如只选中一个换行）。
 */

/** 文档选区锚点：克隆一份 Range（用户后续拖动/取消选区都改不到它）。 */
function rangeAnchor(range) {
  if (range === null || range === undefined || typeof range.cloneRange !== 'function') return null;
  try {
    return { kind: 'range', range: range.cloneRange() };
  } catch (error) {
    return null;
  }
}

/** 侧栏浏览器锚点：宿主元素 + guest 局部矩形 + guest 缩放系数。 */
function guestAnchor(element, guestRect, zoom) {
  if (element === null || element === undefined) return null;
  return {
    kind: 'guest',
    element: element,
    guestRect: { left: guestRect?.left ?? 0, top: guestRect?.top ?? 0, width: guestRect?.width ?? 0, height: guestRect?.height ?? 0 },
    zoom: typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
  };
}

/** 元素在宿主视口里的矩形（拿不到就是零矩形）。 */
function elementRect(element) {
  if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  var box = null;
  try {
    box = element.getBoundingClientRect();
  } catch (error) {
    box = null;
  }
  if (box === null || box === undefined) return { left: 0, top: 0, width: 0, height: 0 };
  return {
    left: Number.isFinite(box.left) ? box.left : 0,
    top: Number.isFinite(box.top) ? box.top : 0,
    width: Number.isFinite(box.width) ? box.width : 0,
    height: Number.isFinite(box.height) ? box.height : 0,
  };
}

/** 元素的缩放系数（读不到、或返回 Promise 都当 1）。 */
function zoomFactorFor(element) {
  if (element === null || element === undefined || typeof element.getZoomFactor !== 'function') return 1;
  var factor = null;
  try {
    factor = element.getZoomFactor();
  } catch (error) {
    factor = null;
  }
  return typeof factor === 'number' && Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/** 锚点当前在宿主视口里的矩形；锚点已失效时返回 null（调用方据此收起卡片）。 */
function rectOfAnchor(anchor) {
  if (anchor === null || anchor === undefined) return null;

  if (anchor.kind === 'range') {
    var range = anchor.range;
    if (range === null || range === undefined || typeof range.getBoundingClientRect !== 'function') return null;
    var container = range.startContainer;
    if (container !== null && container !== undefined && container.isConnected === false) return null;
    return rectOfRange(range);
  }

  if (anchor.kind === 'guest') {
    var element = anchor.element;
    if (element === null || element === undefined) return null;
    if (element.isConnected === false) return null;
    return composeRect(elementRect(element), anchor.guestRect, anchor.zoom);
  }

  return null;
}

return {
  rangeAnchor: rangeAnchor,
  guestAnchor: guestAnchor,
  elementRect: elementRect,
  zoomFactorFor: zoomFactorFor,
  rectOfAnchor: rectOfAnchor,
};

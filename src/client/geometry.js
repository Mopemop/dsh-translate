/**
 * 弹窗几何与文本规整。
 *
 * 这里**全部是纯函数**：不读 DOM 全局、不碰 React。原因很实际——
 * 「弹窗跑出视口 / 坐标 NaN / 选区贴底时被切掉」这类问题只在真实页面里偶发，
 * 而真实页面没法在 Node 里跑；把这套算术抽干净，就能在单测里把边界枚举完。
 */

/** 卡片默认宽度（与 client.css 里的 .dst-card 宽度保持一致）。 */
var CARD_WIDTH = 340;

/** 选区底边与卡片之间的间距。 */
var CARD_GAP = 10;

/** 卡片与视口边缘的最小留白。 */
var CARD_MARGIN = 8;

/** 单次选区最多带多少字符进卡片（超长选区截断，避免把整份文档塞进弹窗）。 */
var MAX_TEXT_CHARS = 4000;

/**
 * 把值夹进两个边界之间。
 *
 * 语义有意放宽：**两个边界按无序区间处理**（取小的当低界、大的当高界）。
 * 这样调用点不必先判断 `min <= max`，而"视口比卡片还窄"这类退化情形下
 * 计算结果依然是两个边界之一，不会漏出 NaN 或越界值。
 */
function clamp(value, min, max) {
  var low = Math.min(min, max);
  var high = Math.max(min, max);
  if (typeof value !== 'number' || !Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * 规整选区文本 —— 只做展示层面的归一，不改语义。
 *
 * 为什么必须做：浏览器 `selection.toString()` 会把源码缩进、软换行、全角空格
 * 原样带出来。代码片段选中三行，卡片里就会出现一坨锯齿状的前导空格；
 * 而连续空行会让卡片高度失控。所以：
 *   · 统一换行符（\r\n、\r → \n）；
 *   · 行内连续空白压成一个空格（含不换行空格），但**保留换行**；
 *   · 行尾空白去掉，连续空行最多留一个；
 *   · 首尾整体 trim。
 */
function normalizeText(raw) {
  if (typeof raw !== 'string') return '';
  var text = raw.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** 超长选区截断；返回是否截断过，让卡片能提示"只翻译了前面一段"。 */
function clampText(text, max) {
  var limit = typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : MAX_TEXT_CHARS;
  if (text.length <= limit) return { text: text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/**
 * 视口尺寸。
 *
 * 传 `undefined` = "用全局 window"；传 `null` = "没有窗口"，直接给保守默认值。
 * 两者必须区分：组件里 `viewportOf(props.window)` 在真实页面拿到的是 undefined
 * （此时该读全局），而测试台显式传 null 时想要的是"没有窗口"这条分支。
 */
function viewportOf(win) {
  var source = win;
  if (source === undefined) source = typeof window === 'undefined' ? null : window;
  if (source === null) return { width: 1024, height: 768 };
  var width = typeof source.innerWidth === 'number' && Number.isFinite(source.innerWidth) ? source.innerWidth : 0;
  var height = typeof source.innerHeight === 'number' && Number.isFinite(source.innerHeight) ? source.innerHeight : 0;
  return { width: width > 0 ? width : 1024, height: height > 0 ? height : 768 };
}

/**
 * 视口 → 带原点的边界矩形。
 *
 * `placeCard` 原本只认 `{width, height}`（原点固定 0,0）。但卡片实际该被夹在
 * **右侧栏**里，而侧栏有自己的 left/top —— 所以这里统一成"边界矩形"，
 * 让 `placeCard` 只认一种形状。
 */
function viewportBounds(viewport) {
  var width = viewport !== null && viewport !== undefined && Number.isFinite(viewport.width) ? viewport.width : 1024;
  var height = viewport !== null && viewport !== undefined && Number.isFinite(viewport.height) ? viewport.height : 768;
  return { left: 0, top: 0, right: width, bottom: height, width: width, height: height };
}

/**
 * 两个边界矩形的交集（卡片要同时待在两边内）。
 *
 * 不相交时返回 `null` —— 调用方据此选择"退而求其次"的边界，
 * 而不是给出一个宽高为负的怪矩形。
 */
function intersectBounds(a, b) {
  if (a === null || a === undefined) return b === undefined ? null : b;
  if (b === null || b === undefined) return a;
  var left = Math.max(a.left, b.left);
  var top = Math.max(a.top, b.top);
  var right = Math.min(a.right, b.right);
  var bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
}

/** 把一个矩形规整成边界矩形（DOMRect / 普通对象都认）。 */
function boundsOfRect(rect) {
  if (rect === null || rect === undefined) return null;
  var left = Number.isFinite(rect.left) ? rect.left : 0;
  var top = Number.isFinite(rect.top) ? rect.top : 0;
  var width = Number.isFinite(rect.width) ? rect.width : 0;
  var height = Number.isFinite(rect.height) ? rect.height : 0;
  if (width <= 0 || height <= 0) return null;
  return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height };
}

/**
 * 把选区矩形规整成四个有限数值。
 *
 * 两种真实退化都要兜住：
 *   · 跨行选区 `getBoundingClientRect()` 给的是**整个跨行外接矩形**（可能横跨整页宽），
 *     直接拿它居中会把卡片顶到一边 —— 这时取 `getClientRects()[0]`（第一行）更贴近
 *     "文本下方"的直觉；
 *   · 某些渲染场景下 rect 全 0，也要返回零矩形而不是 undefined，让 placeCard 仍可用。
 */
function rectOfRange(range) {
  var source = null;
  if (range !== null && range !== undefined && typeof range.getBoundingClientRect === 'function') {
    source = range.getBoundingClientRect();
  }
  if (source === null || source === undefined || (source.width === 0 && source.height === 0)) {
    var rects = range !== null && range !== undefined && typeof range.getClientRects === 'function' ? range.getClientRects() : null;
    if (rects !== null && rects !== undefined && rects.length > 0) source = rects[0];
  }
  var rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  if (source === null || source === undefined) return rect;
  rect.left = Number.isFinite(source.left) ? source.left : 0;
  rect.top = Number.isFinite(source.top) ? source.top : 0;
  rect.width = Number.isFinite(source.width) ? source.width : Math.max(0, (Number.isFinite(source.right) ? source.right : rect.left) - rect.left);
  rect.height = Number.isFinite(source.height) ? source.height : Math.max(0, (Number.isFinite(source.bottom) ? source.bottom : rect.top) - rect.top);
  rect.right = rect.left + rect.width;
  rect.bottom = rect.top + rect.height;
  return rect;
}

/**
 * 卡片落点。**默认贴在选区正下方**，下方放不下才翻到上方。
 *
 * @param anchor - 选区矩形（视口坐标）
 * @param size - 卡片已量到的尺寸（首帧高度是 0，量到后会再算一次）
 * @param viewport - 视口尺寸
 * @returns { left, top, width, placement }，placement ∈ 'below' | 'above'
 *
 * 三条规则，各有各的必要性：
 *   1. **贴下方**：弹窗盖住原文是最影响阅读的做法，所以默认永远在下方；
 *   2. **翻上方**：只有"下方确实放不下"（贴到视口底部）才翻，而不是"上方空间更大"；
 *   3. **夹回视口**：上下都放不下（选区几乎占满视口）时夹进视口内。
 *
 * 第 3 条有个必须显式处理的退化情形：**卡片比视口还高**（长选区 + 矮窗口）。
 * 这时"完全放进视口"在数学上不可能，规则必须让位给"至少让顶部可见"——
 * 钉在顶部留白处，超出部分由卡片自己的 max-height/滚动去消化。
 * 若无脑按 `viewport.height - margin - height` 当上界，算出来是负数，
 * 卡片会被推到视口上方看不见的地方（这个 bug 是被 2000 组随机输入抓出来的）。
 */
function placeCard(anchor, size, viewport) {
  // 第三个参数可以是视口尺寸（{width,height}，原点 0,0），
  // 也可以是带原点的边界矩形（右侧栏的框）——统一成后者再算
  var bounds = viewport !== null && viewport !== undefined && Number.isFinite(viewport.left) ? viewport : viewportBounds(viewport);
  var width = Math.min(CARD_WIDTH, Math.max(160, bounds.width - CARD_MARGIN * 2));
  var height = size !== null && size !== undefined && Number.isFinite(size.height) ? Math.max(0, size.height) : 0;
  var below = anchor.bottom + CARD_GAP;
  var fitsBelow = below + height <= bounds.bottom - CARD_MARGIN;
  var placement = fitsBelow ? 'below' : 'above';
  var top = fitsBelow ? below : anchor.top - CARD_GAP - height;
  var maxTop = Math.max(bounds.top + CARD_MARGIN, bounds.bottom - CARD_MARGIN - height);
  top = clamp(top, bounds.top + CARD_MARGIN, maxTop);
  var centered = anchor.left + anchor.width / 2 - width / 2;
  var maxLeft = Math.max(bounds.left + CARD_MARGIN, bounds.right - width - CARD_MARGIN);
  var left = clamp(centered, bounds.left + CARD_MARGIN, maxLeft);
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    placement: placement,
  };
}

/**
 * 视口坐标合成：把"容器矩形 + 容器内矩形（× 缩放）"合成为宿主视口坐标。
 *
 * 放在 geometry 而不是 guest-bridge 里，是为了打破一个循环依赖：
 * 侧栏浏览器的选区锚点要用它重新合成坐标，而锚点模块又被选区桥依赖。
 */
function composeRect(containerRect, innerRect, zoom) {
  var factor = typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  var left = (containerRect.left || 0) + (innerRect.left || 0) * factor;
  var top = (containerRect.top || 0) + (innerRect.top || 0) * factor;
  var width = (innerRect.width || 0) * factor;
  var height = (innerRect.height || 0) * factor;
  return { left: left, top: top, width: width, height: height, right: left + width, bottom: top + height };
}

return {
  CARD_WIDTH: CARD_WIDTH,
  CARD_GAP: CARD_GAP,
  CARD_MARGIN: CARD_MARGIN,
  MAX_TEXT_CHARS: MAX_TEXT_CHARS,
  clamp: clamp,
  normalizeText: normalizeText,
  clampText: clampText,
  viewportOf: viewportOf,
  viewportBounds: viewportBounds,
  intersectBounds: intersectBounds,
  boundsOfRect: boundsOfRect,
  rectOfRange: rectOfRange,
  placeCard: placeCard,
  composeRect: composeRect,
};

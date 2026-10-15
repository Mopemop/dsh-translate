/**
 * dsh-translate 浏览器半侧 bundle —— **构建产物，请勿直接编辑**。
 *
 * 源码在 src/client/ 下按模块拆分，重新生成：node scripts/build.mjs
 *
 * 模块（顺序 = 初始化顺序）：
 *   geometry.js      弹窗几何与文本规整（纯函数，可单测）
 *   scope.js         作用域判定：只认右侧栏，并排除卡片自身
 *   translate.js     客户端引擎接缝：方向/引擎选择、宿主调用、运输方式回退
 *   styles.js        样式注入（CSS 文本在 styles/client.css）
 *   anchor.js        选区锚点：滚动/改窗口后重新算卡片落点（锚点失效才收起）
 *   selection.js     选区监听器（事件时序集中在这里）
 *   guest-bridge.js  侧栏浏览器选区桥（executeJavaScript 注入 + 轮询取事件）
 *   popup.js         翻译卡片与浮层组件（文档选区与浏览器选区两条来源）
 *   plugin.js        插件入口：槽位注册、样式与生命周期
 */
window.__ModuleLoader__.load({
  id: "dsh-translate",
  factory: function (require) {
    /** 模块表：按 MODULES 顺序初始化，前一个可以是后一个的依赖。 */
    var __factories = {};
    var __cache = {};
    function R(name) {
      if (Object.prototype.hasOwnProperty.call(__cache, name)) return __cache[name];
      var factory = __factories[name];
      if (factory === undefined) throw new Error('未知模块：' + name);
      var exports = factory();
      __cache[name] = exports;
      return exports;
    }

    // ===================== geometry =====================
    __factories["geometry"] = function () {
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
    };

    // ===================== scope =====================
    __factories["scope"] = function () {
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
    };

    // ===================== translate =====================
    __factories["translate"] = function () {
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
   * 真实的失败原因。宿主侧自动模式最坏情况 = 免费引擎 8s × 2 + 模型 45s = 61s，
   * 再加上读会话状态的两次限时（投影 3s / 日志 1.5s），这里留到 80s。
   */
  var REQUEST_TIMEOUT_MS = 80000;

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
    };

    // ===================== styles =====================
    __factories["styles"] = function () {
  /**
   * 样式注入。
   *
   * 浏览器半侧的 bundle 是**没有顶层 import 的普通脚本**，拿不到打包器注入的
   * CSS 管线，所以样式以文本形式随产物一起送到页面，由本模块挂一个 <style>。
   *
   * 两个细节是有意的：
   *   · 用 `data-plugin` / `data-plugin-css` 标记自己 —— 与 DSH 自带插件同一套约定，
   *     便于在 Elements 面板里一眼看出这块样式是谁的；
   *   · 重复注入直接跳过：插件被加载两次（HMR、或用户手工再加一条 entry）时，
   *     页面里只该有一份样式，否则规则数量翻倍、调试时看到的永远是旧那份。
   */

  /** 样式标签的身份（同时是 data-plugin-css 的值）。 */
  var STYLE_TAG = 'dsh-translate/card';

  /** 构建期由 scripts/build.mjs 用 src/client/styles/client.css 的内容替换。 */
  var CSS_TEXT = "/* ============================================================================\n * dsh-translate 卡片样式\n * ============================================================================\n *\n * 约定：\n *   · 类名一律 dst- 前缀（dsh translate），避免和宿主/其它插件撞车；\n *   · 颜色只用主题令牌（--dsw-alias-*），这样浅色/深色主题自动跟随，\n *     不在插件里硬编码任何颜色 —— 浅色主题下硬编码深色底就是\"白屏上糊一块黑\"；\n *   · **每条规则写在单行**：构建脚本的 CSS 自检按行判断规则是否完整\n *     （跨行规则会被判为\"不完整的单行规则\"而构建失败）。\n *\n * 布局要点：\n *   · .dst-card 是浮层（shell.overlay）里的直接子元素，width 由 JS 按视口夹取后\n *     以 inline style 给出；这里只提供兜底宽度；\n *   · .dst-card 必须显式 pointer-events:auto —— 浮层容器是 pointer-events:none，\n *     忘了这条的话卡片看得见但点不动（复制/关闭全失效）。\n * ==========================================================================*/\n\n.dst-card { position: fixed; box-sizing: border-box; display: flex; flex-direction: column; width: 340px; max-width: calc(100vw - 16px); pointer-events: auto; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); border: .5px solid var(--dsw-alias-border-l2); border-radius: 10px; box-shadow: 0 10px 30px rgba(0, 0, 0, .22); font: var(--dsw-font-xxs-12, 12px/1.5 system-ui, sans-serif); }\n.dst-card[data-placement=\"above\"] { box-shadow: 0 -10px 30px rgba(0, 0, 0, .18); }\n\n.dst-head { display: flex; align-items: center; gap: 6px; padding: 7px 8px 7px 10px; border-bottom: .5px solid var(--dsw-alias-border-l1); border-radius: 10px 10px 0 0; background: var(--dsw-alias-bg-layer-1); }\n.dst-title { font-weight: 600; }\n.dst-lang { display: inline-flex; align-items: center; gap: 2px; max-width: 98px; padding: 1px 4px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; overflow: hidden; white-space: nowrap; }\n.dst-lang-source { margin-left: auto; }\n.dst-lang:hover { background: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-label-primary); }\n.dst-lang[data-open=\"1\"] { background: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-label-primary); }\n.dst-lang-source:not([data-source=\"auto\"]) { color: var(--dsw-alias-brand-primary); }\n.dst-lang-target:not([data-target=\"zh-CN\"]) { color: var(--dsw-alias-brand-primary); }\n.dst-arrow { flex: none; color: var(--dsw-alias-label-secondary); }\n.dst-close { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 14px; line-height: 1; }\n.dst-close:hover { background: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-label-primary); }\n\n.dst-body { display: flex; flex-direction: column; gap: 6px; padding: 9px 10px; max-height: 46vh; overflow: auto; }\n.dst-block { display: flex; flex-direction: column; gap: 3px; }\n.dst-label { color: var(--dsw-alias-label-secondary); font-size: 11px; letter-spacing: .02em; }\n.dst-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }\n.dst-source { max-height: 108px; overflow: auto; color: var(--dsw-alias-label-primary); }\n.dst-target { max-height: 180px; overflow: auto; }\n.dst-target[data-state=\"loading\"] { color: var(--dsw-alias-label-secondary); }\n.dst-target[data-stale=\"1\"] { opacity: .55; }\n.dst-target[data-state=\"error\"] { color: var(--dsw-alias-state-error-primary); }\n.dst-rule { height: .5px; background: var(--dsw-alias-border-l1); }\n\n.dst-foot { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-top: .5px solid var(--dsw-alias-border-l1); border-radius: 0 0 10px 10px; background: var(--dsw-alias-bg-layer-1); }\n.dst-engine { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; padding: 2px 5px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; text-align: left; overflow: hidden; white-space: nowrap; }\n.dst-engine:hover { background: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-label-primary); }\n.dst-engine[data-open=\"1\"] { background: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-label-primary); }\n.dst-caret { flex: none; font-size: 9px; opacity: .7; }\n.dst-hint { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; }\n.dst-menu { position: absolute; left: 6px; right: 6px; z-index: 3; box-sizing: border-box; max-height: 240px; overflow: auto; padding: 4px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 10px 28px rgba(0, 0, 0, .24); }\n.dst-menuItem { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 7px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; text-align: left; }\n.dst-menuItem:hover { background: var(--dsw-alias-state-idle-primary); }\n.dst-menuItem[data-current=\"1\"] { color: var(--dsw-alias-brand-primary); }\n.dst-menuLabel { flex: none; }\n.dst-menuCheck { flex: none; }\n.dst-menuHint { flex: 1; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.dst-menu-compact { left: auto; right: auto; width: max-content; min-width: 104px; max-width: 200px; max-height: 216px; padding: 3px; border-radius: 7px; font-size: 11px; }\n.dst-menuItem-compact { gap: 4px; padding: 3px 6px; border-radius: 5px; font-size: 11px; line-height: 1.35; }\n.dst-menuItem-compact .dst-menuLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.dst-menuItem-compact .dst-menuCheck { margin-left: auto; font-size: 10px; }\n.dst-copy { flex: none; padding: 3px 9px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; }\n.dst-retry { flex: none; padding: 3px 9px; border: .5px solid var(--dsw-alias-state-error-primary); border-radius: 5px; background: transparent; color: var(--dsw-alias-state-error-primary); cursor: pointer; font: inherit; }\n.dst-retry:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }\n.dst-copy:hover:not(:disabled) { background: var(--dsw-alias-state-idle-primary); }\n.dst-copy:disabled { color: var(--dsw-alias-label-secondary); cursor: default; opacity: .55; }";

  /** 样式文本（测试台用来断言关键规则存在）。 */
  function cssText() {
    return CSS_TEXT;
  }

  /**
   * 注入样式。
   * @returns 卸载函数（移除这个 <style>），交给 ctx.effect 管理生命周期。
   */
  function installCss() {
    if (typeof document === 'undefined' || document === null) return function () {};
    if (document.head === undefined || document.head === null) return function () {};
    var existing = typeof document.querySelector === 'function' ? document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') : null;
    if (existing !== null && existing !== undefined) return function () {};
    var tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-translate';
    tag.dataset.pluginCss = STYLE_TAG;
    tag.textContent = CSS_TEXT;
    document.head.appendChild(tag);
    return function () {
      if (tag.parentNode !== null && tag.parentNode !== undefined) tag.parentNode.removeChild(tag);
    };
  }

  return {
    STYLE_TAG: STYLE_TAG,
    cssText: cssText,
    installCss: installCss,
  };
    };

    // ===================== anchor =====================
    __factories["anchor"] = function () {
  var geometry = R("geometry");
  var CARD_WIDTH = geometry.CARD_WIDTH;
  var CARD_GAP = geometry.CARD_GAP;
  var CARD_MARGIN = geometry.CARD_MARGIN;
  var MAX_TEXT_CHARS = geometry.MAX_TEXT_CHARS;
  var clamp = geometry.clamp;
  var normalizeText = geometry.normalizeText;
  var clampText = geometry.clampText;
  var viewportOf = geometry.viewportOf;
  var viewportBounds = geometry.viewportBounds;
  var intersectBounds = geometry.intersectBounds;
  var boundsOfRect = geometry.boundsOfRect;
  var rectOfRange = geometry.rectOfRange;
  var placeCard = geometry.placeCard;
  var composeRect = geometry.composeRect;
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
    };

    // ===================== selection =====================
    __factories["selection"] = function () {
  var scope = R("scope");
  var SCOPE_SELECTORS = scope.SCOPE_SELECTORS;
  var SCOPE_QUERY = scope.SCOPE_QUERY;
  var elementOfNode = scope.elementOfNode;
  var isInSidebar = scope.isInSidebar;
  var isInsideElement = scope.isInsideElement;
  var sessionIdOf = scope.sessionIdOf;
  var sidebarRectOf = scope.sidebarRectOf;
  var captureDraft = scope.captureDraft;
  var geometry = R("geometry");
  var CARD_WIDTH = geometry.CARD_WIDTH;
  var CARD_GAP = geometry.CARD_GAP;
  var CARD_MARGIN = geometry.CARD_MARGIN;
  var MAX_TEXT_CHARS = geometry.MAX_TEXT_CHARS;
  var clamp = geometry.clamp;
  var normalizeText = geometry.normalizeText;
  var clampText = geometry.clampText;
  var viewportOf = geometry.viewportOf;
  var viewportBounds = geometry.viewportBounds;
  var intersectBounds = geometry.intersectBounds;
  var boundsOfRect = geometry.boundsOfRect;
  var rectOfRange = geometry.rectOfRange;
  var placeCard = geometry.placeCard;
  var composeRect = geometry.composeRect;
  /**
   * 选区监听器：把"用户在右侧栏里划完一段话"变成一次 onPick 回调。
   *
   * 这个模块把**事件时序**这件麻烦事集中到一处，React 组件那边只管展示。
   * 时序上有四个真问题，每个都对应下面一段代码：
   *
   *   1. **mouseup 时选区还没稳定**：拖选结束的瞬间 `getSelection()` 有时还是旧的，
   *      所以要推到下一个 tick 再读（schedulePick），不能同步读。
   *   2. **点卡片会把文档选区点没**：卡片浮在文档上，鼠标按下去浏览器会先塌陷选区，
   *      于是 selectionchange 一到就把卡片关了 —— 复制/关闭按钮根本点不到。
   *      对策是两道保险：卡片自身 mousedown 阻止默认（见 popup.js），
   *      以及这里的 popupGuard（在卡片内按下时，忽略这次塌陷）。
   *   3. **滚动/改窗口大小后锚点会漂**：卡片是按"当前视口坐标"算的，
   *      锚点一动它就贴在错误的位置上 —— 直接关掉，比错位好。
   *   4. **Escape 必须关**：划词翻译是打断性 UI，键盘出口是硬要求。
   *
   * 所有依赖（document / window / 取元素 / 判定作用域）都由 options 注入，
   * 于是这个监听器可以在 Node 里用假 document 完整驱动，不用真浏览器。
   */

  /**
   * @param options.document - 宿主文档
   * @param options.window - 宿主窗口（提供 getSelection / setTimeout / 事件绑定）
   * @param options.onPick - (draft) => void，选中了一段该翻译的文本
   * @param options.onClear - () => void，应当收起卡片
   * @param options.getPopupElement - () => Element|null，卡片根节点（用于排除自身）
   * @returns { start, stop, pick, isPopupGuarded } —— pick 是测试接缝
   */
  function createWatcher(options) {
    var doc = options.document === undefined ? null : options.document;
    var win = options.window === undefined ? null : options.window;
    var bound = [];
    var timer = 0;
    var settleTimer = 0;
    var stopped = false;
    var popupGuard = false;
    var reanchorScheduled = false;
    /**
     * 上一次已经交出去的选区文本。
     *
     * 用来去重：`selectionchange` 与 `mouseup` 都会触发取词（见 onSelectionChange 的说明），
     * 同一段文本被取两次就会**重新翻译一遍**（卡片闪一下、白花一次请求）。
     * 只有在"已经收起"时才清空它，这样用户收起后再选同一段文本仍然会弹。
     */
    var lastPicked = '';

    function popupElement() {
      if (typeof options.getPopupElement !== 'function') return null;
      var element = options.getPopupElement();
      return element === undefined ? null : element;
    }

    function listen(target, type, handler, capture) {
      if (target === null || target === undefined || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler, capture === true);
      bound.push({ target: target, type: type, handler: handler, capture: capture === true });
    }

    function currentSelection() {
      if (win === null || typeof win.getSelection !== 'function') return null;
      try {
        return win.getSelection();
      } catch (error) {
        return null;
      }
    }

    var SELECTION_SETTLE_MS = 180;

    function clear() {
      if (stopped) return;
      lastPicked = '';
      options.onClear();
    }

    /** 读一次选区：该弹就把草稿交出去，不该弹就收起。 */
    function pick() {
      timer = 0;
      if (stopped) return;
      // 见文件头第 2 条：用户正在卡片里操作，这次塌陷不算"取消划词"
      if (popupGuard) return;
      var draft = captureDraft({
        selection: currentSelection(),
        isInSidebar: isInSidebar,
        isInsidePopup: function (element) {
          return isInsideElement(element, popupElement());
        },
        rectOfRange: rectOfRange,
        normalizeText: normalizeText,
        clampText: clampText,
      });
      if (draft === null) {
        clear();
        return;
      }
      // 同一段文本已经交出去过（mouseup + selectionchange 各来一次）→ 不重复取词，
      // 否则会重新翻译一遍、卡片闪一下
      if (draft.text === lastPicked) return;
      lastPicked = draft.text;
      options.onPick(draft);
    }

    /** 推到下一个 tick 再读（见文件头第 1 条）。 */
    function schedulePick() {
      if (stopped) return;
      if (timer !== 0 && win !== null && typeof win.clearTimeout === 'function') win.clearTimeout(timer);
      // 选区刚稳定，不需要再等
      if (settleTimer !== 0 && win !== null && typeof win.clearTimeout === 'function') win.clearTimeout(settleTimer);
      settleTimer = 0;
      if (win === null || typeof win.setTimeout !== 'function') {
        pick();
        return;
      }
      timer = win.setTimeout(pick, 0);
    }

    /**
     * 选区"稳定下来"之后的兜底取词。
     *
     * 为什么需要：拖到侧栏外松手时，外面的元素可能 `stopPropagation()` 掉 mouseup
     * （对话区就有这种处理），只靠 mouseup 会漏掉这次划词。selectionchange 是浏览器
     * 直接派发的，吞不掉 —— 于是等它安静 180ms 再取一次。
     * 顺带把键盘选区（双击、Shift+方向键、Ctrl+A）也覆盖了。
     */
    function scheduleSettle() {
      if (stopped) return;
      if (settleTimer !== 0 && win !== null && typeof win.clearTimeout === 'function') win.clearTimeout(settleTimer);
      if (win === null || typeof win.setTimeout !== 'function') return;
      settleTimer = win.setTimeout(function () {
        settleTimer = 0;
        pick();
      }, SELECTION_SETTLE_MS);
    }

    function onMouseUp(event) {
      // 捕获阶段收到的非主键（右键菜单等）不算划词结束
      if (event !== null && event !== undefined && typeof event.button === 'number' && event.button !== 0) return;
      schedulePick();
    }

    function onMouseDown(event) {
      var target = event === null || event === undefined ? null : event.target;
      if (isInsideElement(target, popupElement())) {
        popupGuard = true;
        return;
      }
      popupGuard = false;
      clear();
    }

    function onKeyUp(event) {
      var key = event === null || event === undefined ? undefined : event.key;
      if (key === 'Escape') {
        popupGuard = false;
        clear();
        return;
      }
      schedulePick();
    }

    function onKeyDown(event) {
      if (event !== null && event !== undefined && event.key === 'Escape') {
        popupGuard = false;
        clear();
      }
    }

    function onSelectionChange() {
      if (stopped || popupGuard) return;
      var selection = currentSelection();
      if (selection === null || selection.isCollapsed === true) {
        clear();
        return;
      }
      // 选区非空：等它安静下来再取（覆盖"mouseup 被外面吞掉"与键盘选区）
      scheduleSettle();
    }

    /**
     * 视口变化（scroll / resize）。
     *
     * 三种情形必须分开处理：
     *   ① **卡片自己内部滚动**（原文区、译文区都是可滚的）—— 那是用户在读译文，
     *      绝不能收起卡片。这是 `scroll` 必须带 capture 监听时最容易被忽略的一条：
     *      卡片内的滚动同样会冒到 window；
     *   ② **外部滚动但锚点还在**（在被预览的文档里往下翻）—— 重新定位，别收起；
     *   ③ **锚点没了**（选区被删、webview 被卸载）—— 收起。
     *
     * ②的重新定位按帧合并：滚动一次会来几十个事件，每个都量一次布局会真的卡。
     */
    function onViewportChange(event) {
      if (stopped) return;
      var target = event === null || event === undefined ? null : event.target;
      if (isInsideElement(target, popupElement())) return;
      popupGuard = false;
      if (typeof options.reanchor !== 'function') {
        clear();
        return;
      }
      scheduleReanchor();
    }

    function scheduleReanchor() {
      if (reanchorScheduled) return;
      reanchorScheduled = true;
      var run = function () {
        reanchorScheduled = false;
        if (stopped) return;
        var moved = false;
        try {
          moved = options.reanchor() === true;
        } catch (error) {
          moved = false;
        }
        // 锚点算不出来了（选区没了/webview 卸载了）才收起
        if (!moved) clear();
      };
      if (win !== null && win !== undefined && typeof win.requestAnimationFrame === 'function') {
        win.requestAnimationFrame(run);
        return;
      }
      run();
    }

    function start() {
      // mouseup 也走捕获阶段：拖到侧栏外松手时，外面的元素（对话区）可能吞掉事件，
      // 冒泡阶段就收不到了 —— 那正是"鼠标在侧栏外松手不弹卡片"的原因
      listen(doc, 'mouseup', onMouseUp, true);
      // mousedown 用捕获阶段：卡片内的按钮若自己吞掉事件，这里也必须先看到
      listen(doc, 'mousedown', onMouseDown, true);
      listen(doc, 'keyup', onKeyUp);
      listen(doc, 'keydown', onKeyDown);
      listen(doc, 'selectionchange', onSelectionChange);
      listen(win, 'scroll', onViewportChange, true);
      listen(win, 'resize', onViewportChange);
    }

    function stop() {
      stopped = true;
      if (timer !== 0 && win !== null && typeof win.clearTimeout === 'function') win.clearTimeout(timer);
      if (settleTimer !== 0 && win !== null && typeof win.clearTimeout === 'function') win.clearTimeout(settleTimer);
      timer = 0;
      settleTimer = 0;
      lastPicked = '';
      for (var i = 0; i < bound.length; i++) {
        var entry = bound[i];
        if (typeof entry.target.removeEventListener === 'function') entry.target.removeEventListener(entry.type, entry.handler, entry.capture);
      }
      bound = [];
    }

    return {
      start: start,
      stop: stop,
      pick: pick,
      schedulePick: schedulePick,
      scheduleSettle: scheduleSettle,
      isPopupGuarded: function () {
        return popupGuard;
      },
    };
  }

  return {
    createWatcher: createWatcher,
  };
    };

    // ===================== guest-bridge =====================
    __factories["guest-bridge"] = function () {
  var geometry = R("geometry");
  var CARD_WIDTH = geometry.CARD_WIDTH;
  var CARD_GAP = geometry.CARD_GAP;
  var CARD_MARGIN = geometry.CARD_MARGIN;
  var MAX_TEXT_CHARS = geometry.MAX_TEXT_CHARS;
  var clamp = geometry.clamp;
  var normalizeText = geometry.normalizeText;
  var clampText = geometry.clampText;
  var viewportOf = geometry.viewportOf;
  var viewportBounds = geometry.viewportBounds;
  var intersectBounds = geometry.intersectBounds;
  var boundsOfRect = geometry.boundsOfRect;
  var rectOfRange = geometry.rectOfRange;
  var placeCard = geometry.placeCard;
  var composeRect = geometry.composeRect;
  var anchor = R("anchor");
  var rangeAnchor = anchor.rangeAnchor;
  var guestAnchor = anchor.guestAnchor;
  var elementRect = anchor.elementRect;
  var zoomFactorFor = anchor.zoomFactorFor;
  var rectOfAnchor = anchor.rectOfAnchor;
  var scope = R("scope");
  var SCOPE_SELECTORS = scope.SCOPE_SELECTORS;
  var SCOPE_QUERY = scope.SCOPE_QUERY;
  var elementOfNode = scope.elementOfNode;
  var isInSidebar = scope.isInSidebar;
  var isInsideElement = scope.isInsideElement;
  var sessionIdOf = scope.sessionIdOf;
  var sidebarRectOf = scope.sidebarRectOf;
  var captureDraft = scope.captureDraft;
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
    };

    // ===================== popup =====================
    __factories["popup"] = function () {
  var react = require('react');
  var h = require('react').createElement;
  var useState = require('react').useState;
  var useEffect = require('react').useEffect;
  var useLayoutEffect = require('react').useLayoutEffect;
  var useRef = require('react').useRef;
  var useMemo = require('react').useMemo;
  var useCallback = require('react').useCallback;
  var geometry = R("geometry");
  var CARD_WIDTH = geometry.CARD_WIDTH;
  var CARD_GAP = geometry.CARD_GAP;
  var CARD_MARGIN = geometry.CARD_MARGIN;
  var MAX_TEXT_CHARS = geometry.MAX_TEXT_CHARS;
  var clamp = geometry.clamp;
  var normalizeText = geometry.normalizeText;
  var clampText = geometry.clampText;
  var viewportOf = geometry.viewportOf;
  var viewportBounds = geometry.viewportBounds;
  var intersectBounds = geometry.intersectBounds;
  var boundsOfRect = geometry.boundsOfRect;
  var rectOfRange = geometry.rectOfRange;
  var placeCard = geometry.placeCard;
  var composeRect = geometry.composeRect;
  var scope = R("scope");
  var SCOPE_SELECTORS = scope.SCOPE_SELECTORS;
  var SCOPE_QUERY = scope.SCOPE_QUERY;
  var elementOfNode = scope.elementOfNode;
  var isInSidebar = scope.isInSidebar;
  var isInsideElement = scope.isInsideElement;
  var sessionIdOf = scope.sessionIdOf;
  var sidebarRectOf = scope.sidebarRectOf;
  var captureDraft = scope.captureDraft;
  var translate = R("translate");
  var API_PATH = translate.API_PATH;
  var HEALTH_PATH = translate.HEALTH_PATH;
  var GET_TEXT_LIMIT = translate.GET_TEXT_LIMIT;
  var TRANSPORT_POST = translate.TRANSPORT_POST;
  var TRANSPORT_GET = translate.TRANSPORT_GET;
  var ENGINE_CYCLE = translate.ENGINE_CYCLE;
  var ENGINE_LABELS = translate.ENGINE_LABELS;
  var DEFAULT_ENGINE = translate.DEFAULT_ENGINE;
  var SOURCE_LANGUAGES = translate.SOURCE_LANGUAGES;
  var TARGET_LANGUAGES = translate.TARGET_LANGUAGES;
  var DEFAULT_SOURCE = translate.DEFAULT_SOURCE;
  var DEFAULT_TARGET = translate.DEFAULT_TARGET;
  var AUTO_SOURCE_LABEL = translate.AUTO_SOURCE_LABEL;
  var REQUEST_TIMEOUT_MS = translate.REQUEST_TIMEOUT_MS;
  var LANGUAGE_LABELS = translate.LANGUAGE_LABELS;
  var languageLabelOf = translate.languageLabelOf;
  var sourceLabelOf = translate.sourceLabelOf;
  var targetLabelOf = translate.targetLabelOf;
  var readSourcePreference = translate.readSourcePreference;
  var writeSourcePreference = translate.writeSourcePreference;
  var readTargetPreference = translate.readTargetPreference;
  var writeTargetPreference = translate.writeTargetPreference;
  var loadingResult = translate.loadingResult;
  var errorResult = translate.errorResult;
  var describeError = translate.describeError;
  var interpretResponse = translate.interpretResponse;
  var resetTransport = translate.resetTransport;
  var canUseGet = translate.canUseGet;
  var sendOnce = translate.sendOnce;
  var readEnginePreference = translate.readEnginePreference;
  var writeEnginePreference = translate.writeEnginePreference;
  var nextEngine = translate.nextEngine;
  var engineLabelOf = translate.engineLabelOf;
  var requestTranslation = translate.requestTranslation;
  var mergeResult = translate.mergeResult;
  var selection = R("selection");
  var createWatcher = selection.createWatcher;
  var guest_bridge = R("guest-bridge");
  var WEBVIEW_SELECTOR = guest_bridge.WEBVIEW_SELECTOR;
  var POLL_INTERVAL_MS = guest_bridge.POLL_INTERVAL_MS;
  var MAX_QUEUE = guest_bridge.MAX_QUEUE;
  var GUEST_INSTALL_SCRIPT = guest_bridge.GUEST_INSTALL_SCRIPT;
  var GUEST_POLL_SCRIPT = guest_bridge.GUEST_POLL_SCRIPT;
  var createGuestBridge = guest_bridge.createGuestBridge;
  var anchor = R("anchor");
  var rangeAnchor = anchor.rangeAnchor;
  var guestAnchor = anchor.guestAnchor;
  var elementRect = anchor.elementRect;
  var zoomFactorFor = anchor.zoomFactorFor;
  var rectOfAnchor = anchor.rectOfAnchor;
  /**
   * 卡片 UI：一个浮在选区下方的翻译对话卡。
   *
   * ## 结构（自上而下）
   *
   *   ┌──────────────────────────────────────────┐
   *   │ 翻译   自动检测 → 中文              ×    │  ← 头：身份 + 语言方向 + 关闭
   *   ├──────────────────────────────────────────┤
   *   │ 原文                                      │
   *   │ <选区文本，最多 108px 高，可滚>            │
   *   │ ─────────────────────────────────────    │
   *   │ 译文                                      │
   *   │ <loading / stub / done / error 四态之一>  │  ← 体：原文在上、译文在下
   *   ├──────────────────────────────────────────┤
   *   │ 说明文字…                        [复制译文] │  ← 脚：状态说明 + 复制
   *   └──────────────────────────────────────────┘
   *
   * ## 两个容易做错的地方
   *
   * 1. **首帧没有高度，落点会算歪**。卡片高度取决于文本长度，渲染前不知道；
   *    所以先用高度 0 算一次（一定贴下方），量到真实高度后用 useLayoutEffect 再算一次
   *    —— 这一步发生的时机在浏览器绘制之前，用户看不到跳动。所以默认"贴下方"这条
   *    在首帧就成立：即便内容很长需要翻到上方，也只是把卡片从下方挪到上方。
   *
   * 2. **卡片里的 mousedown 必须 preventDefault**。否则点"复制译文"会先把文档选区
   *    塌陷掉，selectionchange 随之把卡片关掉，按钮根本点不到（详见 selection.js 头注释）。
   *    这是划词弹窗类 UI 的经典坑，两道保险分别在这里和监听器里。
   */

  var CARD_TITLE = '翻译';
  var CLOSE_LABEL = '关闭';
  var COPY_LABEL = '复制译文';
  var COPIED_LABEL = '已复制';
  var RETRY_LABEL = '重试';
  var LOADING_LABEL = '翻译中…';
  var UPDATING_LABEL = '更新中…';

  /**
   * 请求序号（单调递增）。
   *
   * 用来回答"这个结果还属于当前这一轮吗"。为什么不能用文本比对代替：
   * 切引擎、换方向时文本没变，晚到的旧结果会顶掉新结果；切走又切回来时文本同样没变，
   * 但它其实是又一轮。序号能一次覆盖全部这些情况。
   */
  var requestSeq = 0;

  function nextRequestId() {
    requestSeq++;
    return requestSeq;
  }
  var FALLBACK_ERROR = '翻译失败';
  var TRUNCATED_NOTE = '选区过长，仅取前一段';
  var ERROR_NOTE = '翻译失败，可以重试';
  var MANUAL_SUFFIX = ' · 手动';

  /** 引擎下拉菜单：与卡片之间的间距，以及估算的最大高度（用于决定朝上还是朝下弹）。 */
  var MENU_GAP = 6;
  var MENU_MAX_HEIGHT = 240;
  var MENU_PADDING = 8;
  /** 引擎项一行（带说明）与紧凑项一行的估算高度。 */
  var MENU_OPTION_HEIGHT = 28;
  /** 语言菜单是紧凑变体：一行更矮、整体更小（它不是引擎菜单那种"带说明"的列表）。 */
  var COMPACT_OPTION_HEIGHT = 22;
  var COMPACT_MENU_MAX_HEIGHT = 216;

  /**
   * 每个引擎一句话说明。
   *
   * 下拉菜单的价值就在这行字：用户点开是想知道"该选哪个"，
   * 而不是再看一遍四个名字。
   */
  var ENGINE_HINTS = {
    microsoft: '微软 · 免费端点 · 默认',
    google: 'Google · 免费端点 · 需能访问',
    llm: 'DSH 模型 · 一定能用',
    auto: '依次尝试 · 最慢',
  };

  /** 把引擎结果收敛成三种展示态之一（UI 不认识引擎细节）。 */
  function viewOf(result) {
    var state = result === null || result === undefined ? 'loading' : result.state;
    if (state === 'done') return { kind: 'done', text: typeof result.text === 'string' ? result.text : '' };
    if (state === 'error') {
      var message = typeof result.error === 'string' && result.error !== '' ? result.error : FALLBACK_ERROR;
      return { kind: 'error', text: message };
    }
    return { kind: 'loading', text: LOADING_LABEL };
  }

  /**
   * 草稿里是否带着"上一版可显示的译文"。
   *
   * 用途是切换引擎/方向时**不把译文清空**：旧译文留在原位（变淡），只有引擎标签
   * 变成"更新中…"。否则每次切换都会先闪成"翻译中…"、卡片高度跳两次、还会连带
   * 重新定位 —— 那就是"切换很卡顿"的来源。
   */
  function hasPreviousText(draft) {
    var previous = draft === null || draft === undefined ? null : draft.previous;
    return previous !== null && previous !== undefined && previous.state === 'done' && typeof previous.text === 'string' && previous.text !== '';
  }

  /** 判断一个"结果对象"本身是否带可用译文（rerunDraft 传进来的就是它）。 */
  function hasResultText(result) {
    return result !== null && result !== undefined && result.state === 'done' && typeof result.text === 'string' && result.text !== '';
  }

  /** 引擎标签上的那行字：**这是"结果从哪来"的唯一线索**。
   *
   * 划词翻译是"看一眼就走"的交互，用户需要在这里判断三件事：
   * 用的是哪一家（措辞不一样）、花了多久（模型那路明显慢）、是不是命中缓存。
   * 所以它被做成按钮 —— 想换一家时，落点显然应该在"当前是哪一家"上面。
   */
  function engineChipText(draft, view) {
    var result = draft.result === null || draft.result === undefined ? {} : draft.result;
    var engine = result.engine === null || result.engine === undefined ? null : result.engine;
    var label = engine !== null && typeof engine.label === 'string' && engine.label !== '' ? engine.label : engineLabelOf(draft.engine);
    var model = engine !== null && typeof engine.model === 'string' && engine.model !== '' ? ' ' + engine.model : '';
    var parts = [label + model];
    if (view.kind === 'loading') parts.push(hasPreviousText(draft) ? UPDATING_LABEL : LOADING_LABEL);
    else if (view.kind === 'error') parts.push('失败');
    else {
      if (typeof result.elapsedMs === 'number' && Number.isFinite(result.elapsedMs)) parts.push(result.elapsedMs + 'ms');
      if (result.cached === true) parts.push('缓存');
    }
    return parts.join(' · ');
  }

  /** 脚注里真正的提示（只有"选区被截断"这一件事需要说）。 */
  function hintOf(draft, view) {
    return draft.truncated === true ? TRUNCATED_NOTE : '';
  }

  /** 结果里的引擎 id（用于 chips 的 data 属性与循环切换）。 */
  function engineIdOf(draft) {
    var result = draft.result === null || draft.result === undefined ? {} : draft.result;
    if (result.engine !== null && result.engine !== undefined && typeof result.engine.id === 'string' && result.engine.id !== '') return result.engine.id;
    return typeof draft.engine === 'string' && draft.engine !== '' ? draft.engine : 'auto';
  }

  /** 写剪贴板。失败就当没发生：为一次复制失败弹个提示不值得。 */
  function writeClipboard(text, onDone) {
    var nav = typeof navigator === 'undefined' ? null : navigator;
    if (nav === null || nav === undefined) return;
    if (nav.clipboard === undefined || nav.clipboard === null || typeof nav.clipboard.writeText !== 'function') return;
    try {
      var promise = nav.clipboard.writeText(text);
      if (promise !== null && promise !== undefined && typeof promise.then === 'function') {
        promise.then(function () {
          onDone();
        }, function () {});
      }
    } catch (error) {
      /* 剪贴板被策略拒绝：忽略 */
    }
  }

  /**
   * 卡片本体。
   * @param props.draft - { text, truncated, rect, result }
   * @param props.cardRef - 卡片根节点的 ref（监听器要用它排除"选区落在卡片上"）
   * @param props.window - 视口来源（默认取全局 window，测试可注入）
   */
  function TranslationCard(props) {
    var draft = props.draft;
    var cardRef = props.cardRef;
    var sizePair = useState({ height: 0 });
    var size = sizePair[0];
    var setSize = sizePair[1];
    var copiedPair = useState(false);
    var copied = copiedPair[0];
    var setCopied = copiedPair[1];
    // 引擎下拉是否展开（"点一下换个引擎"太难发现，改成点开选）
    var menuPair = useState(false);
    var menuOpen = menuPair[0];
    var setMenuOpen = menuPair[1];

    // 量高度 → 触发第二次定位。比较后再 set，避免每次渲染都进一次 setState 循环。
    useLayoutEffect(function () {
      var node = cardRef === null || cardRef === undefined ? null : cardRef.current;
      if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return;
      var rect = node.getBoundingClientRect();
      var height = Number.isFinite(rect.height) ? Math.round(rect.height) : 0;
      if (height !== size.height) setSize({ height: height });
    });

    // 卡片边界 = 窗口视口 ∩ 右侧栏。只按窗口夹取的话，靠边的选区会把卡片推到对话区，
    // 那部分既盖住别的区域、又点不动（用户实测现象）。
    var bounds = cardBoundsOf(draft, props.window);
    var box = placeCard(draft.rect, { height: size.height }, bounds);
    var view = viewOf(draft.result);
    var hint = hintOf(draft, view);
    // 重新翻译期间把上一版译文留在原位（只是变淡），见 hasPreviousText 的说明
    var stale = view.kind === 'loading' && hasPreviousText(draft);
    var shownText = stale ? draft.previous.text : view.text;
    // 可复制的是"真译文"：更新中的旧译文可以复制，但"翻译中…"/错误文案不是内容
    var canCopy = stale || (view.kind === 'done' && view.text !== '');
    var currentEngine = engineIdOf(draft);

    var head = h('div', { className: 'dst-head', key: 'head' }, [
      h('span', { className: 'dst-title', key: 'title' }, CARD_TITLE),
      // 源语言与目标语言是**两个独立选择器**（默认 自动检测 → 中文）。
      // 之前合成一个"点一下换方向"的按钮：方向猜错时能换，但没法指定原文语言，
      // 也没法从中文换到别的目标语言。分开之后每个都能直接点开选。
      h(
        'button',
        {
          className: 'dst-lang dst-lang-source',
          key: 'source',
          type: 'button',
          title: '选择原文语言',
          'data-source': draft.source,
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen === 'source' ? 'true' : 'false',
          'data-open': menuOpen === 'source' ? '1' : undefined,
          onClick: function () {
            setMenuOpen(menuOpen === 'source' ? null : 'source');
          },
        },
        [sourceLabelOf(draft.source), h('span', { className: 'dst-caret', key: 'caret' }, '▾')],
      ),
      h('span', { className: 'dst-arrow', key: 'arrow' }, '→'),
      h(
        'button',
        {
          className: 'dst-lang dst-lang-target',
          key: 'target',
          type: 'button',
          title: '选择目标语言',
          'data-target': draft.target,
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen === 'target' ? 'true' : 'false',
          'data-open': menuOpen === 'target' ? '1' : undefined,
          onClick: function () {
            setMenuOpen(menuOpen === 'target' ? null : 'target');
          },
        },
        [targetLabelOf(draft.target), h('span', { className: 'dst-caret', key: 'caret' }, '▾')],
      ),
      h(
        'button',
        {
          className: 'dst-close',
          key: 'close',
          type: 'button',
          title: CLOSE_LABEL,
          'aria-label': CLOSE_LABEL,
          onClick: function () {
            props.onClose();
          },
        },
        '×',
      ),
    ]);

    var body = h('div', { className: 'dst-body', key: 'body' }, [
      h('div', { className: 'dst-block', key: 'source' }, [
        h('div', { className: 'dst-label', key: 'label' }, '原文'),
        h('div', { className: 'dst-text dst-source', key: 'text' }, draft.text),
      ]),
      h('div', { className: 'dst-rule', key: 'rule' }),
      h('div', { className: 'dst-block', key: 'target' }, [
        h('div', { className: 'dst-label', key: 'label' }, '译文'),
        h('div', { className: 'dst-text dst-target', key: 'text', 'data-state': view.kind, 'data-stale': stale ? '1' : undefined }, shownText),
      ]),
    ]);

    var foot = h('div', { className: 'dst-foot', key: 'foot' }, [
      h(
        'button',
        {
          className: 'dst-engine',
          key: 'engine',
          type: 'button',
          title: '选择翻译引擎',
          'data-engine': currentEngine,
          'data-open': menuOpen === 'engine' ? '1' : undefined,
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen === 'engine' ? 'true' : 'false',
          onClick: function () {
            // 诊断日志：区分"点击没到达按钮"与"逻辑没生效"——
            // 前者是环境问题（有东西盖住了/事件被吞），后者是代码问题
            if (typeof console !== 'undefined' && typeof console.log === 'function') {
              console.log('[dsh-translate] 引擎标签被点击（' + (menuOpen === 'engine' ? '收起' : '展开') + '菜单）');
            }
            setMenuOpen(menuOpen === 'engine' ? null : 'engine');
          },
        },
        [engineChipText(draft, view), h('span', { className: 'dst-caret', key: 'caret' }, '▾')],
      ),
      hint === ''
        ? null
        : h('span', { className: 'dst-hint', key: 'hint' }, hint),
      view.kind === 'error' && typeof props.onRetry === 'function'
        ? h(
            'button',
            {
              className: 'dst-retry',
              key: 'retry',
              type: 'button',
              onClick: function () {
                props.onRetry();
              },
            },
            RETRY_LABEL,
          )
        : null,
      h(
        'button',
        {
          className: 'dst-copy',
          key: 'copy',
          type: 'button',
          disabled: !canCopy,
          title: canCopy ? COPY_LABEL : LOADING_LABEL,
          onClick: function () {
            if (!canCopy) return;
            writeClipboard(shownText, function () {
              setCopied(true);
            });
          },
        },
        copied ? COPIED_LABEL : COPY_LABEL,
      ),
    ]);

    var children = [head, body, foot];
    // ⚠️ 菜单必须是**卡片的子节点**，不能做成兄弟节点。
    // 监听器判断"这次按下是不是在弹窗内部"用的是 `card.contains(target)`：
    // 菜单一旦在卡片之外，点选项就会被判成"点了外面"→ 先 clear() 把卡片收掉，
    // 点击根本到不了选项上（这正是"切换引擎后弹窗直接消失"的原因）。
    if (menuOpen === 'engine') {
      children = [
        head,
        body,
        foot,
        dropdownMenu({
          kind: 'engine',
          box: box,
          size: size,
          bounds: bounds,
          current: currentEngine,
          options: ENGINE_CYCLE.map(function (id) {
            return { value: id, label: engineLabelOf(id), hint: ENGINE_HINTS[id] === undefined ? '' : ENGINE_HINTS[id] };
          }),
          onPick: function (id) {
            if (typeof props.onPickEngine === 'function') props.onPickEngine(id);
          },
          close: setMenuOpen,
        }),
      ];
    } else if (menuOpen === 'source' || menuOpen === 'target') {
      var isSource = menuOpen === 'source';
      var current = isSource ? draft.source : draft.target;
      var list = isSource ? SOURCE_LANGUAGES : TARGET_LANGUAGES;
      children = [
        head,
        body,
        foot,
        dropdownMenu({
          kind: menuOpen,
          box: box,
          size: size,
          bounds: bounds,
          current: current,
          // 语言菜单是**紧凑变体**：贴着触发按钮（源语言靠左、目标语言靠右）、
          // 宽度按内容、没有说明列、字号更小 —— 它不该长得像下面那个引擎菜单。
          compact: true,
          options: list.map(function (code) {
            return { value: code, label: languageLabelOf(code) };
          }),
          onPick: function (code) {
            if (isSource) {
              if (typeof props.onPickSource === 'function') props.onPickSource(code);
            } else if (typeof props.onPickTarget === 'function') props.onPickTarget(code);
          },
          close: setMenuOpen,
        }),
      ];
    }

    return h(
      'div',
      {
        className: 'dst-card',
        'data-translate-card': 'card',
        'data-placement': box.placement,
        'data-state': view.kind,
        'data-menu': menuOpen === null ? undefined : '1',
        role: 'dialog',
        'aria-label': CARD_TITLE,
        ref: cardRef,
        style: { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px' },
        // 见文件头第 2 条：不让这次按下塌陷文档选区。
        // 顺带负责"点卡片别处就收起菜单"——但落点在菜单或某个触发器上时要放过，
        // 否则 mousedown 会先把菜单关掉、紧接着 click 又把它打开（闪烁）。
        onMouseDown: function (event) {
          if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
          if (menuOpen === null) return;
          var target = event === null || event === undefined ? null : event.target;
          var onTrigger = target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('.dst-menu, .dst-engine, .dst-lang') !== null;
          if (!onTrigger) setMenuOpen(null);
        },
      },
      children,
    );
  }

  /**
   * 卡片的可用边界：窗口视口 ∩ 右侧栏。
   *
   * 三件事按顺序发生：
   *   1. 拿窗口视口（原点 0,0）；
   *   2. 拿这次选区所属侧栏的矩形（`[data-sidebar-right-session]`，浮动面板退到最近容器）；
   *   3. 取交集 —— 交集为空（侧栏被拖到屏幕外之类）就退回窗口，宁可位置不理想也不能不显示。
   *
   * 侧栏矩形从哪来：文档选区用 `draft.element`（captureDraft 给的），
   * 浏览器选区用 `draft.anchor.element`（webview 元素）——两者都能往上找到侧栏根。
   */
  function cardBoundsOf(draft, win) {
    var viewport = viewportBounds(viewportOf(win));
    var element = draft !== null && draft !== undefined && draft.element !== undefined && draft.element !== null ? draft.element : null;
    if (element === null && draft !== null && draft !== undefined && draft.anchor !== undefined && draft.anchor !== null) {
      element = draft.anchor.element === undefined ? null : draft.anchor.element;
    }
    var panel = sidebarRectOf(element);
    if (panel === null) return viewport;
    return intersectBounds(viewport, boundsOfRect(panel)) ?? viewport;
  }

  /**
   * 通用下拉菜单（引擎 / 源语言 / 目标语言共用）。
   *
   * 三处选择器的结构完全一样：一个当前值 + 一串候选项 + 选中即回调。
   * 抽成一份而不是写三遍，是因为它们的**落点、遮挡、点内部不收起**这些细节
   * 一旦写错就会重演"点了没反应"那类问题（见 children 上的注释）。
   *
   * 落点：默认贴在卡片下方；下方不够就翻到卡片上方。卡片是 `position: fixed`，
   * 所以这里的 absolute 是相对卡片定位的。
   */
  function dropdownMenu(config) {
    var compact = config.compact === true;
    var rowHeight = compact ? COMPACT_OPTION_HEIGHT : MENU_OPTION_HEIGHT;
    var maxHeight = compact ? COMPACT_MENU_MAX_HEIGHT : MENU_MAX_HEIGHT;
    var estimated = Math.min(config.options.length * rowHeight, maxHeight) + MENU_PADDING;
    // 判定用**侧栏边界**而不是整窗：否则菜单会翻到侧栏外面，那部分同样点不动
    var limit = Number.isFinite(config.bounds?.bottom) ? config.bounds.bottom : Number.isFinite(config.viewport?.height) ? config.viewport.height : 768;
    var fitsBelow = config.box.top + config.size.height + estimated <= limit - CARD_MARGIN;

    var style = fitsBelow ? { top: 'calc(100% + ' + MENU_GAP + 'px)' } : { bottom: 'calc(100% + ' + MENU_GAP + 'px)' };
    if (compact) {
      // 紧凑变体贴着触发按钮那一侧，而不是像引擎菜单那样铺满卡片
      if (config.kind === 'target') style.right = '8px';
      else style.left = '8px';
    }

    return h(
      'div',
      {
        className: compact ? 'dst-menu dst-menu-compact' : 'dst-menu',
        key: config.kind + '-menu',
        'data-menu-kind': config.kind,
        'data-side': fitsBelow ? 'below' : 'above',
        role: 'menu',
        style: style,
        // 菜单本身也要挡掉默认行为，否则点它会把文档选区点没、卡片跟着收起来
        onMouseDown: function (event) {
          if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
        },
      },
      config.options.map(function (option) {
        return h(
          'button',
          {
            className: compact ? 'dst-menuItem dst-menuItem-compact' : 'dst-menuItem',
            key: option.value,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': option.value === config.current ? 'true' : 'false',
            'data-option': option.value,
            'data-current': option.value === config.current ? '1' : undefined,
            onClick: function () {
              config.close(null);
              config.onPick(option.value);
            },
          },
          compact
            ? [
                h('span', { className: 'dst-menuLabel', key: 'label' }, option.label),
                option.value === config.current ? h('span', { className: 'dst-menuCheck', key: 'check' }, '✓') : null,
              ]
            : [
                h('span', { className: 'dst-menuLabel', key: 'label' }, option.label),
                option.value === config.current ? h('span', { className: 'dst-menuCheck', key: 'check' }, '✓') : null,
                h('span', { className: 'dst-menuHint', key: 'hint' }, option.hint === undefined ? '' : option.hint),
              ],
        );
      }),
    );
  }

  /**
   * 发起一次翻译：先以 loading 立起卡片（用户立刻看到反馈），结果回来再替换。
   *
   * 三个细节：
   *   · **源语言和目标语言都在这一步定**：默认读用户偏好（首次是 自动检测 → 中文），
   *     在下拉里选了哪个就带 options.source / options.target 重跑；
   *   · **引擎也在这一步定**：默认读用户偏好（首次是微软翻译），点引擎下拉时带
   *     options.engine 重跑 —— 三个选择器走同一条重跑路径，不做三套状态机；
   *   · **过期结果**：见 requestId 的说明（只认当前那一轮的结果）。
   */
  function beginTranslation(picked, setDraft, options) {
    var opts = options === null || options === undefined ? {} : options;
    var source = typeof opts.source === 'string' && opts.source !== '' ? opts.source : readSourcePreference();
    var target = typeof opts.target === 'string' && opts.target !== '' ? opts.target : readTargetPreference();
    var engine = typeof opts.engine === 'string' && opts.engine !== '' ? opts.engine : readEnginePreference();
    // 锚点：优先用调用方给的（重跑时沿用），否则从这次选区的原始 Range 克隆一个
    var anchor = opts.anchor !== undefined && opts.anchor !== null ? opts.anchor : rangeAnchor(picked.range === undefined ? null : picked.range);
    var previous = opts.previous === undefined || opts.previous === null ? null : opts.previous;
    var pending = {
      text: picked.text,
      truncated: picked.truncated === true,
      rect: picked.rect,
      source: source,
      target: target,
      manual: opts.manual === true,
      engine: engine,
      // 会话 id（"跟随当前对话的模型"用）：随选区一起带过来，重跑时沿用
      sessionId: typeof picked.sessionId === 'string' ? picked.sessionId : '',
      anchor: anchor,
      previous: hasResultText(previous) ? previous : null,
      requestId: nextRequestId(),
      result: loadingResult(target),
    };
    setDraft(pending);

    var promise;
    try {
      promise = requestTranslation({ text: picked.text, source: source, target: target, engine: engine, sessionId: pending.sessionId });
    } catch (error) {
      promise = Promise.reject(error);
    }

    promise.then(
      function (result) {
        setDraft(function (current) {
          // 只认"当前那一轮"的结果。
          // ⚠️ 光比对文本不够：切引擎 / 换方向时**文本根本没变**，晚到的旧结果
          // 会照样覆盖新结果（实测：先看 Google、再切回微软，Google 的失败结果
          // 把微软的译文顶掉了）。每次发起领一个单调递增的号，号不对就原样返回 ——
          // 换引擎、换方向、重试、甚至切回原来那一家，都各自是新的一轮。
          if (current === null || current.requestId !== pending.requestId) return current;
          return mergeResult(current, result);
        });
      },
      function (error) {
        setDraft(function (current) {
          if (current === null || current.requestId !== pending.requestId) return current;
          return mergeResult(current, errorResult(target, describeError(error), 'CLIENT_FAILURE'));
        });
      },
    );
  }

  /** 重跑当前草稿（重试 / 换方向 / 换引擎共用一条路径，避免三套状态机漂移）。 */
  function rerunDraft(draft, setDraft, options) {
    if (draft === null || draft === undefined) return;
    var opts = options === null || options === undefined ? {} : options;
    beginTranslation(
      { text: draft.text, truncated: draft.truncated === true, rect: draft.rect, range: null, sessionId: draft.sessionId },
      setDraft,
      {
        source: typeof opts.source === 'string' && opts.source !== '' ? opts.source : draft.source,
        target: typeof opts.target === 'string' && opts.target !== '' ? opts.target : draft.target,
        manual: opts.manual === true,
        engine: typeof opts.engine === 'string' && opts.engine !== '' ? opts.engine : draft.engine,
        // 沿用锚点（滚过之后也能继续跟随），并把上一版译文带过去显示
        anchor: draft.anchor,
        previous: draft.result,
      },
    );
  }

  /**
   * 挂进 shell.overlay 的那个组件：无卡片时返回 null（浮层里不留空壳），
   * 有卡片时把卡片渲染成浮层的直接子元素（浮层给直接子元素 pointer-events:auto）。
   *
   * ## 两条选区来源，一个卡片
   *
   *   · **文档预览**（同文档 DOM）：走 selection.js 的监听器，作用域判定在 scope.js；
   *   · **侧栏浏览器**（跨域 webview）：走 guest-bridge.js 的桥，坐标由桥合成到宿主视口。
   *
   * 两者最终都产出同一份草稿（{ text, truncated, rect }）交给 beginTranslation，
   * 所以卡片、定位与状态机只有一份实现——差异只存在于"怎么拿到选区"。
   * 卡片上带 `data-source` 只是给调试与将来"按来源微调样式"留的抓手。
   */
  function TranslateOverlay(props) {
    var pair = useState(null);
    var draft = pair[0];
    var setDraft = pair[1];
    var cardRef = useRef(null);
    /**
     * 当前草稿的"最新值"引用。
     *
     * 为什么需要它：滚动时监听器要问"锚点还在吗"，而 `setDraft(fn)` 在 React 里是
     * 异步的 —— 没法从 updater 里把结果同步返回给监听器。所以渲染时同步写一份，
     * 监听器直接读它。
     */
    var draftRef = useRef(null);
    draftRef.current = draft;

    useEffect(function () {
      var doc = typeof document === 'undefined' ? null : document;
      var win = typeof window === 'undefined' ? null : window;

      // 来源一：同文档 DOM（右栏的文件树与文档预览）
      var watcher = createWatcher({
        document: doc,
        window: win,
        getPopupElement: function () {
          return cardRef.current;
        },
        onPick: function (picked) {
          beginTranslation(picked, setDraft);
        },
        onClear: function () {
          setDraft(null);
        },
        // 宿主滚动时重新算落点（而不是把卡片收掉）：锚点还在就跟着走，没了才收起
        reanchor: function () {
          var current = draftRef.current;
          if (current === null || current === undefined) return false;
          var rect = rectOfAnchor(current.anchor);
          if (rect === null) return false;
          setDraft(Object.assign({}, current, { rect: rect }));
          return true;
        },
      });
      watcher.start();

      // 来源二：侧栏浏览器（Electron <webview>，跨域，只能靠 executeJavaScript 桥）
      var bridge = createGuestBridge({
        document: doc,
        window: win,
        onPick: function (picked) {
          beginTranslation(picked, setDraft);
        },
        onClear: function () {
          setDraft(null);
        },
        onDiagnostic: function (message) {
          // 只报不做：能力缺失（例如 webview 元素没有 executeJavaScript）时
          // 浏览器 tab 静默失效，但控制台能看出原因
          if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn('[dsh-translate] ' + message);
          }
        },
      });
      bridge.start();

      return function () {
        watcher.stop();
        bridge.stop();
      };
    }, []);

    if (draft === null) return null;
    return h(TranslationCard, {
      draft: draft,
      cardRef: cardRef,
      window: props === null || props === undefined ? undefined : props.window,
      onClose: function () {
        setDraft(null);
      },
      onRetry: function () {
        rerunDraft(draft, setDraft, { source: draft.source, target: draft.target, manual: draft.manual === true, engine: draft.engine });
      },
      // 源语言：手动指定原文语言（默认"自动检测"）。指定之后不再让引擎猜，
      // 译文质量在"引擎把日语当中文"这类场景下会明显不同。
      onPickSource: function (code) {
        writeSourcePreference(code);
        rerunDraft(draft, setDraft, { source: code, target: draft.target, engine: draft.engine });
      },
      // 目标语言：默认中文，可换任意语种
      onPickTarget: function (code) {
        writeTargetPreference(code);
        rerunDraft(draft, setDraft, { source: draft.source, target: code, manual: true, engine: draft.engine });
      },
      onPickEngine: function (id) {
        if (typeof console !== 'undefined' && typeof console.log === 'function') {
          console.log('[dsh-translate] 切换引擎 → ' + id);
        }
        // 记住选择：下次划词直接用这一家
        writeEnginePreference(id);
        rerunDraft(draft, setDraft, { source: draft.source, target: draft.target, manual: draft.manual === true, engine: id });
      },
    });
  }

  return {
    TranslationCard: TranslationCard,
    TranslateOverlay: TranslateOverlay,
    beginTranslation: beginTranslation,
    rerunDraft: rerunDraft,
    viewOf: viewOf,
    engineChipText: engineChipText,
    engineIdOf: engineIdOf,
    hintOf: hintOf,
  };
    };

    // ===================== plugin =====================
    __factories["plugin"] = function () {
  var react = require('react');
  var h = require('react').createElement;
  var useState = require('react').useState;
  var useEffect = require('react').useEffect;
  var useLayoutEffect = require('react').useLayoutEffect;
  var useRef = require('react').useRef;
  var useMemo = require('react').useMemo;
  var useCallback = require('react').useCallback;
  var styles = R("styles");
  var STYLE_TAG = styles.STYLE_TAG;
  var cssText = styles.cssText;
  var installCss = styles.installCss;
  var popup = R("popup");
  var TranslationCard = popup.TranslationCard;
  var TranslateOverlay = popup.TranslateOverlay;
  var beginTranslation = popup.beginTranslation;
  var rerunDraft = popup.rerunDraft;
  var viewOf = popup.viewOf;
  var engineChipText = popup.engineChipText;
  var engineIdOf = popup.engineIdOf;
  var hintOf = popup.hintOf;
  var geometry = R("geometry");
  var CARD_WIDTH = geometry.CARD_WIDTH;
  var CARD_GAP = geometry.CARD_GAP;
  var CARD_MARGIN = geometry.CARD_MARGIN;
  var MAX_TEXT_CHARS = geometry.MAX_TEXT_CHARS;
  var clamp = geometry.clamp;
  var normalizeText = geometry.normalizeText;
  var clampText = geometry.clampText;
  var viewportOf = geometry.viewportOf;
  var viewportBounds = geometry.viewportBounds;
  var intersectBounds = geometry.intersectBounds;
  var boundsOfRect = geometry.boundsOfRect;
  var rectOfRange = geometry.rectOfRange;
  var placeCard = geometry.placeCard;
  var composeRect = geometry.composeRect;
  var scope = R("scope");
  var SCOPE_SELECTORS = scope.SCOPE_SELECTORS;
  var SCOPE_QUERY = scope.SCOPE_QUERY;
  var elementOfNode = scope.elementOfNode;
  var isInSidebar = scope.isInSidebar;
  var isInsideElement = scope.isInsideElement;
  var sessionIdOf = scope.sessionIdOf;
  var sidebarRectOf = scope.sidebarRectOf;
  var captureDraft = scope.captureDraft;
  var selection = R("selection");
  var createWatcher = selection.createWatcher;
  var translate = R("translate");
  var API_PATH = translate.API_PATH;
  var HEALTH_PATH = translate.HEALTH_PATH;
  var GET_TEXT_LIMIT = translate.GET_TEXT_LIMIT;
  var TRANSPORT_POST = translate.TRANSPORT_POST;
  var TRANSPORT_GET = translate.TRANSPORT_GET;
  var ENGINE_CYCLE = translate.ENGINE_CYCLE;
  var ENGINE_LABELS = translate.ENGINE_LABELS;
  var DEFAULT_ENGINE = translate.DEFAULT_ENGINE;
  var SOURCE_LANGUAGES = translate.SOURCE_LANGUAGES;
  var TARGET_LANGUAGES = translate.TARGET_LANGUAGES;
  var DEFAULT_SOURCE = translate.DEFAULT_SOURCE;
  var DEFAULT_TARGET = translate.DEFAULT_TARGET;
  var AUTO_SOURCE_LABEL = translate.AUTO_SOURCE_LABEL;
  var REQUEST_TIMEOUT_MS = translate.REQUEST_TIMEOUT_MS;
  var LANGUAGE_LABELS = translate.LANGUAGE_LABELS;
  var languageLabelOf = translate.languageLabelOf;
  var sourceLabelOf = translate.sourceLabelOf;
  var targetLabelOf = translate.targetLabelOf;
  var readSourcePreference = translate.readSourcePreference;
  var writeSourcePreference = translate.writeSourcePreference;
  var readTargetPreference = translate.readTargetPreference;
  var writeTargetPreference = translate.writeTargetPreference;
  var loadingResult = translate.loadingResult;
  var errorResult = translate.errorResult;
  var describeError = translate.describeError;
  var interpretResponse = translate.interpretResponse;
  var resetTransport = translate.resetTransport;
  var canUseGet = translate.canUseGet;
  var sendOnce = translate.sendOnce;
  var readEnginePreference = translate.readEnginePreference;
  var writeEnginePreference = translate.writeEnginePreference;
  var nextEngine = translate.nextEngine;
  var engineLabelOf = translate.engineLabelOf;
  var requestTranslation = translate.requestTranslation;
  var mergeResult = translate.mergeResult;
  var guest_bridge = R("guest-bridge");
  var WEBVIEW_SELECTOR = guest_bridge.WEBVIEW_SELECTOR;
  var POLL_INTERVAL_MS = guest_bridge.POLL_INTERVAL_MS;
  var MAX_QUEUE = guest_bridge.MAX_QUEUE;
  var GUEST_INSTALL_SCRIPT = guest_bridge.GUEST_INSTALL_SCRIPT;
  var GUEST_POLL_SCRIPT = guest_bridge.GUEST_POLL_SCRIPT;
  var createGuestBridge = guest_bridge.createGuestBridge;
  var anchor = R("anchor");
  var rangeAnchor = anchor.rangeAnchor;
  var guestAnchor = anchor.guestAnchor;
  var elementRect = anchor.elementRect;
  var zoomFactorFor = anchor.zoomFactorFor;
  var rectOfAnchor = anchor.rectOfAnchor;
  /**
   * 插件入口：把划词翻译挂到 frame 级浮层上。
   *
   * ## 挂载点只有一个
   *
   *   shell.overlay —— "Frame-wide floating layer, above every column and outside their
   *   scroll containers"。选它而不是往右栏里塞的原因：
   *
   *     · 卡片要贴在**视口坐标**的选区下方，浮动面板/全屏面板/停靠面板三种形态下
   *       右栏自身的坐标原点都在变，只有 frame 级浮层与视口同源；
   *     · 卡片不会被右栏的 overflow 裁掉（右栏内容区是滚动的，塞进去会被切边）；
   *     · 浮层的直接子元素自动获得 pointer-events:auto（容器本身是 none），
   *       卡片因此天然可点，不用跟宿主的层叠规则较劲。
   *
   *   代价是"浮层在右栏之外"，所以作用域判定（只认右栏选区）必须自己做，
   *   那部分在 scope.js 里。
   *
   * ## 启停是干净的
   *
   * apply 只做两件事：注入样式、注册一个浮层条目；两者都返回卸载函数。
   * 因此用户在插件页关掉本插件时，页面上不会残留样式或监听器。
   */

  /** 要挂的槽位。 */
  var OVERLAY_SLOT = 'shell.overlay';

  /** 浮层条目的 id（槽位内唯一）。 */
  var OVERLAY_ID = 'translate-popup';

  /** 排序：数值越大越靠上层。行情挂件用 800/810，翻译卡片压在它们之上。 */
  var OVERLAY_ORDER = 900;

  /** 包版本，构建期由 scripts/build.mjs 从 package.json 注入（避免两处漂移）。 */
  var VERSION = "0.9.2";

  /**
   * 启动时在控制台留一行身份。
   *
   * 为什么值得留：客户端 bundle 是宿主按"文件元数据派生的 revision"发布到页面的，
   * 改了源码之后**刷新页面不一定换到新产物**（要看宿主有没有重新组合）。
   * 有了这行，"页面里跑的到底是哪一版、浏览器桥在不在"就是一眼的事，
   * 不用去猜要不要重启。
   */
  function reportStartup() {
    if (typeof console === 'undefined' || typeof console.log !== 'function') return;
    console.log(
      '[dsh-translate] v' +
        VERSION +
        ' 已加载 · 文档划词 ✔ · 侧栏浏览器桥 ✔（轮询 ' +
        POLL_INTERVAL_MS +
        'ms）· 引擎=宿主路由 ' +
        API_PATH,
    );
  }

  /**
   * Cordis 插件体。
   * @param ctx - 客户端 Cordis 上下文（inject: slots）
   */
  function apply(ctx) {
    reportStartup();

    ctx.effect(function () {
      return installCss();
    }, 'dsh-translate: card styles');

    ctx.slots.inject(OVERLAY_SLOT, function* () {
      yield ctx.slots.register(
        {
          name: OVERLAY_SLOT,
          id: OVERLAY_ID,
          order: OVERLAY_ORDER,
          label: function () {
            return '划词翻译';
          },
        },
        function (slotProps) {
          return h(TranslateOverlay, slotProps);
        },
      );
    });
  }

  return {
    name: 'dsh-translate',
    // 只需要槽位服务：本插件不读 layout / locale / theme
    inject: ['slots'],
    apply: apply,
    /**
     * 测试接缝。
     *
     * 浏览器半侧没法在 Node 里真的跑起来，所以关键逻辑都从模块里转出来，
     * 让 test/ 下的测试台能直接驱动（几何算术、选区判决、监听器时序、卡片渲染）。
     * 这些导出不影响运行时。
     */
    __test: {
      OVERLAY_SLOT: OVERLAY_SLOT,
      OVERLAY_ID: OVERLAY_ID,
      OVERLAY_ORDER: OVERLAY_ORDER,
      VERSION: VERSION,
      // 几何：纯函数，边界直接在单测里枚举
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
      // 作用域：判决顺序与效果
      SCOPE_SELECTORS: SCOPE_SELECTORS,
      SCOPE_QUERY: SCOPE_QUERY,
      elementOfNode: elementOfNode,
      isInSidebar: isInSidebar,
      isInsideElement: isInsideElement,
      sessionIdOf: sessionIdOf,
      sidebarRectOf: sidebarRectOf,
      captureDraft: captureDraft,
      // 选区监听器：事件时序
      createWatcher: createWatcher,
      // 侧栏浏览器选区桥：webview 选择器、注入脚本、坐标合成
      WEBVIEW_SELECTOR: WEBVIEW_SELECTOR,
      POLL_INTERVAL_MS: POLL_INTERVAL_MS,
      GUEST_INSTALL_SCRIPT: GUEST_INSTALL_SCRIPT,
      GUEST_POLL_SCRIPT: GUEST_POLL_SCRIPT,
      composeRect: composeRect,
      createGuestBridge: createGuestBridge,
      // 锚点：滚动/改窗口后重新计算卡片落点
      rangeAnchor: rangeAnchor,
      guestAnchor: guestAnchor,
      rectOfAnchor: rectOfAnchor,
      // 引擎接缝（客户端侧：宿主路由的调用、运输方式回退与结果收敛）
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
      // UI
      TranslationCard: TranslationCard,
      TranslateOverlay: TranslateOverlay,
      beginTranslation: beginTranslation,
      rerunDraft: rerunDraft,
      viewOf: viewOf,
      engineChipText: engineChipText,
      engineIdOf: engineIdOf,
      hintOf: hintOf,
      // 样式
      STYLE_TAG: STYLE_TAG,
      cssText: cssText,
      installCss: installCss,
    },
  };
    };

    // ===================== 启动 =====================
    var plugin = R('plugin');
    return { apply: plugin.apply, inject: plugin.inject, name: plugin.name, __test: plugin.__test };
  },
});

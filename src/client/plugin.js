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
var VERSION = __PACKAGE_VERSION__;

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
    // 诊断上报（真机取证用）
    DIAG_PATH: DIAG_PATH,
    reportDiag: reportDiag,
    digest: digest,
    rectBrief: rectBrief,
    elementBrief: elementBrief,
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

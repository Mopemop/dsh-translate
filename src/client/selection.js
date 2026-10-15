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

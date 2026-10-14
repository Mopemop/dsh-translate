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

  var box = placeCard(draft.rect, { height: size.height }, viewportOf(props.window));
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
  var viewport = viewportOf(props.window);
  if (menuOpen === 'engine') {
    children = [
      head,
      body,
      foot,
      dropdownMenu({
        kind: 'engine',
        box: box,
        size: size,
        viewport: viewport,
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
        viewport: viewport,
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
  var fitsBelow = config.box.top + config.size.height + estimated <= config.viewport.height - CARD_MARGIN;

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

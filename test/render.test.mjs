/**
 * 卡片渲染与浮层接线的测试台。
 *
 * 分三层：
 *   1. **产物形态** —— 无顶层 import/export、注册 id、`h` 绑的是 createElement；
 *   2. **槽位注册** —— 恰好一个 shell.overlay 条目 + 一份样式；
 *   3. **渲染** —— 卡片四种状态各渲一遍，再把"划词 → 弹卡 → 引擎落地"整条链路
 *      用假 document 的事件驱动跑通。
 *
 * 第 3 层是重点：它验证的不是"某个函数返回值对不对"，而是
 * "用户在右栏划了一段话之后，屏幕上多出来的东西长得对不对"。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadBundle,
  check,
  summary,
  makeCtx,
  render,
  resetMount,
  textOf,
  findNode,
  byClass,
  collectNumbers,
  fire,
  flushTimers,
  resetListeners,
  setSelection,
  cardNode,
  resetCardNode,
  created,
  clipboard,
  fakeWindow,
  listenerCount,
  http,
  resetHttp,
  resetStorage,
} from './harness.mjs';

const { registration, plugin, api, source } = loadBundle();
const { TranslationCard, TranslateOverlay, placeCard, cssText, STYLE_TAG } = api;
// 宿主侧的语言名表：用来钉住"客户端能选到 = 宿主认得出"（见语言表一致性用例）
const { LANGUAGE_NAMES } = await import('../lib/engine.js');

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const ANCHOR = rect(400, 300, 200, 20);

const TR_DONE = { state: 'done', text: '敏捷的棕色狐狸跳过了懒狗。', target: 'zh-CN', engine: { id: 'microsoft', label: '微软翻译' }, elapsedMs: 812, cached: false };

/**
 * 可变的"选区矩形 + 存活状态"。
 *
 * 用来模拟两件事：滚动让选区矩形移动（卡片该跟着走），
 * 以及选区/webview 失效（卡片该收起）。`isConnected` 必须是 getter，
 * 否则克隆出来的 Range 会一直记着创建那一刻的存活状态。
 */
const anchorState = { box: rect(120, 260, 220, 18), connected: true };

function makeRange() {
  return {
    startContainer: {
      get isConnected() {
        return anchorState.connected;
      },
    },
    getBoundingClientRect: () => anchorState.box,
    getClientRects: () => [],
    cloneRange: () => makeRange(),
  };
}

function draftOf(overrides) {
  return Object.assign(
    {
      text: 'The quick brown fox jumps over the lazy dog.',
      truncated: false,
      rect: ANCHOR,
      target: 'zh-CN',
      manual: false,
      result: TR_DONE,
    },
    overrides,
  );
}

// ----------------------------------------------------------------- 产物形态

check('产物：没有顶层 import', /^\s*import\s/m.test(source) === false);
check('产物：没有顶层 export', /^\s*export\s/m.test(source) === false);
check('产物：注册到 __ModuleLoader__', source.includes('window.__ModuleLoader__.load('));
check('产物：注册 id 等于包名', registration?.id === 'dsh-translate', String(registration?.id));
check(
  '产物：h 绑到 react.createElement（不是 jsx-runtime 的 jsx）',
  source.includes("var h = require('react').createElement;"),
  (source.match(/var h = require\([^)]*\)[^;]*;/g) ?? []).slice(0, 2).join(' | '),
);
check(
  '插件体：apply / inject / name 齐备',
  typeof plugin.apply === 'function' && Array.isArray(plugin.inject) && plugin.name === 'dsh-translate',
  JSON.stringify({ inject: plugin.inject, name: plugin.name }),
);
check('插件体：只依赖 slots 服务', plugin.inject.length === 1 && plugin.inject[0] === 'slots', JSON.stringify(plugin.inject));

// 版本号由构建期从 package.json 注入：产物里的版本必须与清单一致，
// 否则"控制台那行身份"会说谎，而它正是用来判断"页面里跑的是哪一版"的
{
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  check('产物：版本号来自 package.json（不是手写的）', api.VERSION === manifest.version, `${api.VERSION} vs ${manifest.version}`);
  check('产物：没有残留占位符', source.includes('__PACKAGE_VERSION__') === false && source.includes('__CSS_TEXT__') === false);
}

// ----------------------------------------------------------------- 槽位注册

const { ctx, registrations } = makeCtx();
plugin.apply(ctx);

const registers = registrations.filter((row) => row.kind === 'register');
const effects = registrations.filter((row) => row.kind === 'effect');
check('注册：恰好一个浮层条目', registers.length === 1, JSON.stringify(registers.map((row) => row.options)));
check('注册：挂在 shell.overlay 上', registers[0]?.options?.name === 'shell.overlay', String(registers[0]?.options?.name));
check('注册：条目 id 是 translate-popup', registers[0]?.options?.id === 'translate-popup', String(registers[0]?.options?.id));
check('注册：有排序值（要压在行情挂件之上）', registers[0]?.options?.order === 900, String(registers[0]?.options?.order));
check('注册：带可读标签（插件页/调试用）', typeof registers[0]?.options?.label === 'function' && registers[0].options.label() === '划词翻译');
check('注册：样式走 ctx.effect（卸载时可回收）', effects.length === 1 && typeof effects[0].dispose === 'function');

const styleTag = created.find((node) => node.tag === 'style');
check('样式：注入了一个 <style>', styleTag !== undefined);
check('样式：打了插件标记（便于在 Elements 里认领）', styleTag?.dataset?.plugin === 'dsh-translate', JSON.stringify(styleTag?.dataset));
check('样式：标记了样式 id', styleTag?.dataset?.pluginCss === STYLE_TAG, String(styleTag?.dataset?.pluginCss));
check('样式：内容就是卡片 CSS', typeof styleTag?.textContent === 'string' && styleTag.textContent.includes('.dst-card'), String(styleTag?.textContent?.length));

// ----------------------------------------------------------------- CSS 约束

const css = cssText();
check('CSS：卡片显式打开指针事件（浮层容器是 pointer-events:none）', /\.dst-card\{[^}]*pointer-events:auto/.test(css.replace(/\s+/g, '')));
check('CSS：上方模式有独立规则（影子方向要反过来）', css.includes('.dst-card[data-placement="above"]'));
check('CSS：译文两态（loading / error）各有独立样式', ['loading', 'error'].every((state) => css.includes(`[data-state="${state}"]`)));
check('CSS：done 态不加修饰（译文就该是正文样式）', css.includes('[data-state="done"]') === false);
check(
  'CSS：语言选择器是可点的按钮样式（要点得动）',
  /\.dst-lang\{[^}]*cursor:pointer/.test(css.replace(/\s+/g, '')) && /\.dst-lang:hover\{/.test(css.replace(/\s+/g, '')),
);
check(
  'CSS：语言菜单是紧凑变体（更小字号、宽度按内容、不铺满卡片）',
  /\.dst-menu-compact\{[^}]*font-size:11px/.test(css.replace(/\s+/g, '')) &&
    /\.dst-menu-compact\{[^}]*width:max-content/.test(css.replace(/\s+/g, '')) &&
    /\.dst-menu-compact\{[^}]*max-width:200px/.test(css.replace(/\s+/g, '')),
);
check('CSS：紧凑项比引擎项更矮更小', /\.dst-menuItem-compact\{[^}]*padding:3px6px/.test(css.replace(/\s+/g, '')));
check(
  'CSS：手动选过的语言会高亮（默认 auto/中文 保持低调）',
  /\.dst-lang-source:not\(\[data-source="auto"\]\)\{/.test(css.replace(/\s+/g, '')) && /\.dst-lang-target:not\(\[data-target="zh-CN"\]\)\{/.test(css.replace(/\s+/g, '')),
);
check('CSS：重试按钮用错误色（它只出现在失败态）', /\.dst-retry\{[^}]*state-error-primary/.test(css.replace(/\s+/g, '')));
check(
  'CSS：原文与译文都可滚（长选区不撑破卡片）',
  /\.dst-source\{[^}]*overflow:auto/.test(css.replace(/\s+/g, '')) && /\.dst-target\{[^}]*overflow:auto/.test(css.replace(/\s+/g, '')),
);
check('CSS：颜色只用主题令牌（没有硬编码 #hex，否则深色主题会瞎）', /#[0-9a-fA-F]{3,8}\b/.test(css) === false, (css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).join(','));
check('CSS：用了弹层背景令牌', css.includes('var(--dsw-alias-bg-overlay)'));

// ----------------------------------------------------------------- 卡片渲染

const noop = () => {};
function renderCard(draft, extra) {
  resetMount(TranslationCard);
  return render(TranslationCard, Object.assign({ draft: draft, cardRef: { current: null }, onClose: noop }, extra));
}

{
  const tree = renderCard(draftOf({}));
  const card = findNode(tree, (node) => node.props?.['data-translate-card'] === 'card');
  check('卡片：渲染出了卡片根节点', card !== null);
  check('卡片：是 dialog 语义（用户口中的"对话框一样的弹窗"）', card?.props?.role === 'dialog' && card?.props?.['aria-label'] === '翻译');
  check('卡片：标题是「翻译」', textOf(byClass(tree, 'dst-title')) === '翻译');
  check(
    '卡片：头部是两个独立的选择器（源语言 → 目标语言）',
    textOf(byClass(tree, 'dst-lang-source')) !== '' && textOf(byClass(tree, 'dst-lang-target')) !== '' && textOf(byClass(tree, 'dst-arrow')) === '→',
    `${textOf(byClass(tree, 'dst-lang-source'))} ${textOf(byClass(tree, 'dst-arrow'))} ${textOf(byClass(tree, 'dst-lang-target'))}`,
  );
  check('卡片：原文区就是选中的文本', textOf(byClass(tree, 'dst-source')) === draftOf({}).text);
  check('卡片：有「原文」「译文」两个标签', tree.children.flat().map(textOf).join(' ').includes('原文') && textOf(byClass(tree, 'dst-target')) !== '');
  check('卡片：译文本体进了译文区', textOf(byClass(tree, 'dst-target')) === TR_DONE.text, textOf(byClass(tree, 'dst-target')));
  check('卡片：状态写在 data-state 上（样式与调试都靠它）', card?.props?.['data-state'] === 'done', String(card?.props?.['data-state']));
  check(
    '卡片：底部引擎标签给出"结果从哪来"（引擎名 + 耗时）',
    textOf(byClass(tree, 'dst-engine')).includes('微软翻译') && textOf(byClass(tree, 'dst-engine')).includes('812ms'),
    textOf(byClass(tree, 'dst-engine')),
  );
  check('卡片：有译文时复制按钮可用', byClass(tree, 'dst-copy')?.props?.disabled === false);
  check('卡片：成功态没有重试按钮（不留无用入口）', byClass(tree, 'dst-retry') === null);
  check(
    '卡片：坐标是 px 字符串且全部有限（不会出现 NaNpx）',
    (() => {
      const style = card?.props?.style ?? {};
      const values = [style.left, style.top, style.width].map((value) => Number.parseFloat(String(value)));
      return String(style.left).endsWith('px') && String(style.top).endsWith('px') && values.every(Number.isFinite);
    })(),
    JSON.stringify(card?.props?.style),
  );
  check(
    '卡片：默认落在选区正下方',
    card?.props?.['data-placement'] === 'below' && Number.parseFloat(card.props.style.top) === ANCHOR.bottom + api.CARD_GAP,
    `${card?.props?.['data-placement']} top=${card?.props?.style?.top}`,
  );
  check(
    '卡片：水平居中于选区',
    Number.parseFloat(card.props.style.left) === Math.round(ANCHOR.left + ANCHOR.width / 2 - api.CARD_WIDTH / 2),
    String(card.props.style.left),
  );
  check(
    '卡片：所有数值属性有限（递归检查，无 NaN）',
    collectNumbers(tree).every((row) => Number.isFinite(row.value)),
    JSON.stringify(collectNumbers(tree).filter((row) => !Number.isFinite(row.value)).slice(0, 3)),
  );
}

{
  // 贴到视口底部：卡片必须翻到选区上方，否则会被视口切掉
  const bottom = rect(400, 800, 200, 20);
  const tree = renderCard(draftOf({ rect: bottom }));
  const card = findNode(tree, (node) => node.props?.['data-translate-card'] === 'card');
  const expected = placeCard(bottom, { height: 180 }, { width: fakeWindow.innerWidth, height: fakeWindow.innerHeight });
  check('卡片：贴底时翻到上方', card?.props?.['data-placement'] === 'above', String(card?.props?.['data-placement']));
  check(
    '卡片：翻上去的位置用到了量到的高度（不是拍脑袋的常量）',
    Number.parseFloat(card.props.style.top) === expected.top,
    `实际 ${card?.props?.style?.top} / 期望 ${expected.top}（卡片高 180）`,
  );
}

{
  resetCardNode();
  cardNode.getBoundingClientRect = () => ({ width: 340, height: 0, left: 0, top: 0, right: 340, bottom: 0 });
  const tree = renderCard(draftOf({}));
  check('卡片：量不到高度时（0）依然渲染且坐标有限', collectNumbers(tree).every((row) => Number.isFinite(row.value)));
  resetCardNode();
}

{
  const calls = { closed: 0 };
  const tree = renderCard(draftOf({}), { onClose: () => { calls.closed++; } });
  byClass(tree, 'dst-close').props.onClick();
  check('卡片：点 × 触发关闭', calls.closed === 1, String(calls.closed));
}

{
  const tree = renderCard(draftOf({}));
  const card = findNode(tree, (node) => node.props?.['data-translate-card'] === 'card');
  let prevented = 0;
  card.props.onMouseDown({ preventDefault: () => { prevented++; } });
  check('卡片：内部 mousedown 阻止默认（否则点按钮先把选区点没）', prevented === 1);
  let threw = null;
  try {
    card.props.onMouseDown(undefined);
  } catch (error) {
    threw = error;
  }
  check('卡片：缺少事件对象时不抛', threw === null, threw?.message ?? 'ok');
}

// 三态的展示文案与入口
{
  const done = renderCard(draftOf({ result: TR_DONE }));
  check('done 态：译文出现在译文区', textOf(byClass(done, 'dst-target')).includes('敏捷的棕色狐狸'));
  check('done 态：复制按钮可用', byClass(done, 'dst-copy')?.props?.disabled === false);
  check('done 态：data-state 同步', findNode(done, (node) => node.props?.['data-translate-card'] === 'card')?.props?.['data-state'] === 'done');
}
{
  const cached = renderCard(draftOf({ result: { ...TR_DONE, cached: true } }));
  check('done 态：命中缓存时引擎标签标注"缓存"', textOf(byClass(cached, 'dst-engine')).includes('缓存'), textOf(byClass(cached, 'dst-engine')));
}
{
  const loading = renderCard(draftOf({ result: { state: 'loading', text: '', target: 'zh-CN', engine: null } }));
  check('loading 态：显示翻译中', textOf(byClass(loading, 'dst-target')) === '翻译中…', textOf(byClass(loading, 'dst-target')));
  check('loading 态：复制按钮禁用', byClass(loading, 'dst-copy')?.props?.disabled === true);
  check('loading 态：没有重试按钮（还没失败）', byClass(loading, 'dst-retry') === null);
  check(
    'loading 态：引擎标签先显示"请求的那一家"（还没结果可依）',
    textOf(byClass(loading, 'dst-engine')).includes('自动') && textOf(byClass(loading, 'dst-engine')).includes('翻译中'),
    textOf(byClass(loading, 'dst-engine')),
  );
}
{
  const calls = { retried: 0 };
  const failed = renderCard(
    draftOf({ result: { state: 'error', text: '', error: '上游限流', code: 'RATE_LIMIT', target: 'zh-CN', engine: null } }),
    { onRetry: () => { calls.retried++; } },
  );
  check('error 态：显示错误原因', textOf(byClass(failed, 'dst-target')) === '上游限流', textOf(byClass(failed, 'dst-target')));
  check('error 态：引擎标签标出失败', textOf(byClass(failed, 'dst-engine')).includes('失败'), textOf(byClass(failed, 'dst-engine')));
  check('error 态：出现重试按钮', byClass(failed, 'dst-retry') !== null);
  byClass(failed, 'dst-retry').props.onClick();
  check('error 态：点重试会回调（不是装饰）', calls.retried === 1, String(calls.retried));
  check('error 态：复制按钮禁用', byClass(failed, 'dst-copy')?.props?.disabled === true);
}
{
  // 源语言 / 目标语言各是一个下拉：默认 自动检测 → 中文，可手动改
  resetMount(TranslationCard);
  const calls = { source: [], target: [] };
  const props = {
    draft: draftOf({ source: 'auto', target: 'zh-CN' }),
    cardRef: { current: null },
    onClose: noop,
    onPickSource: (code) => calls.source.push(code),
    onPickTarget: (code) => calls.target.push(code),
  };
  let tree = render(TranslationCard, props);

  check(
    '语言：默认就是「自动检测 → 中文」',
    textOf(byClass(tree, 'dst-lang-source')).includes('自动检测') && textOf(byClass(tree, 'dst-lang-target')).includes('中文'),
    `${textOf(byClass(tree, 'dst-lang-source'))} → ${textOf(byClass(tree, 'dst-lang-target'))}`,
  );
  check('语言：两个选择器都带小三角（提示可点开）', textOf(byClass(tree, 'dst-lang-source')).includes('▾') && textOf(byClass(tree, 'dst-lang-target')).includes('▾'));

  // 打开源语言列表
  byClass(tree, 'dst-lang-source').props.onClick();
  tree = render(TranslationCard, props);
  let menu = findNode(tree, (node) => node.props?.['data-menu-kind'] === 'source');
  check('语言：点源语言弹出它的列表', menu !== null);
  check(
    '语言：源语言列表第一位是「自动检测」，其余是具体语言',
    textOf(findNode(menu, (node) => node.props?.['data-option'] === 'auto')).includes('自动检测') &&
      findNode(menu, (node) => node.props?.['data-option'] === 'ja') !== null,
    JSON.stringify(menu?.children?.length),
  );
  check('语言：当前值（auto）在列表里被勾选', findNode(menu, (node) => node.props?.['data-option'] === 'auto')?.props?.['data-current'] === '1');

  // 紧凑变体：语言菜单要比引擎菜单明显小，而且贴着自己那一侧的按钮
  check('语言菜单：用紧凑样式（不是引擎那个宽菜单）', String(menu.props.className).includes('dst-menu-compact'), String(menu.props.className));
  check(
    '语言菜单：每一项也是紧凑项，且**没有说明列**（说明是引擎菜单才需要的）',
    String(findNode(menu, (node) => node.props?.['data-option'] === 'ja').props.className).includes('dst-menuItem-compact') &&
      findNode(menu, (node) => node.props?.className === 'dst-menuHint') === null,
  );
  check('语言菜单：源语言的菜单贴在左边', menu.props.style.left === '8px' && menu.props.style.right === undefined, JSON.stringify(menu.props.style));

  // 选日语 → 回调 + 菜单收起
  findNode(menu, (node) => node.props?.['data-option'] === 'ja').props.onClick();
  check('语言：选源语言会回调它的代码', calls.source.join(',') === 'ja', calls.source.join(','));
  tree = render(TranslationCard, props);
  check('语言：选完自动收起', findNode(tree, (node) => node.props?.['data-menu-kind'] === 'source') === null);

  // 打开目标语言列表：不能出现 auto（"翻译成自动"没有意义）
  byClass(tree, 'dst-lang-target').props.onClick();
  tree = render(TranslationCard, props);
  menu = findNode(tree, (node) => node.props?.['data-menu-kind'] === 'target');
  check('语言：点目标语言弹出它的列表', menu !== null);
  check('语言：目标列表里没有「自动」选项', findNode(menu, (node) => node.props?.['data-option'] === 'auto') === null);
  check(
    '语言：目标列表里有英语等常见语种，当前中文被勾选',
    findNode(menu, (node) => node.props?.['data-option'] === 'en') !== null && findNode(menu, (node) => node.props?.['data-option'] === 'zh-CN')?.props?.['data-current'] === '1',
  );
  check('语言菜单：目标语言的菜单贴在右边（两边各贴各的，不铺满卡片）', menu.props.style.right === '8px' && menu.props.style.left === undefined, JSON.stringify(menu.props.style));
  findNode(menu, (node) => node.props?.['data-option'] === 'en').props.onClick();
  check('语言：选目标语言会回调它的代码', calls.target.join(',') === 'en', calls.target.join(','));

  // 两个菜单互斥：开着源语言的列表时点目标语言，应当只留一个
  resetMount(TranslationCard);
  let two = render(TranslationCard, props);
  byClass(two, 'dst-lang-source').props.onClick();
  two = render(TranslationCard, props);
  byClass(two, 'dst-lang-target').props.onClick();
  two = render(TranslationCard, props);
  check(
    '语言：同时只开一个菜单（点另一个会切换过去）',
    findNode(two, (node) => node.props?.['data-menu-kind'] === 'source') === null && findNode(two, (node) => node.props?.['data-menu-kind'] === 'target') !== null,
  );
  check('语言：手动选过的语言靠 data 属性高亮（默认不高亮）', (() => {
    const manual = renderCard(draftOf({ source: 'ja', target: 'en' }));
    return byClass(manual, 'dst-lang-source')?.props?.['data-source'] === 'ja' && byClass(manual, 'dst-lang-target')?.props?.['data-target'] === 'en';
  })());
}
{
  // 引擎标签：点开是下拉选择（不再是"点一下循环下一个"）
  resetMount(TranslationCard);
  const calls = { picked: [] };
  const props = { draft: draftOf({}), cardRef: { current: null }, onClose: noop, onPickEngine: (id) => calls.picked.push(id) };
  let tree = render(TranslationCard, props);

  check('下拉：默认不展开', findNode(tree, (node) => node.props?.['data-menu-kind'] === 'engine') === null);
  const chip = byClass(tree, 'dst-engine');
  check(
    '下拉：标签标了当前引擎与展开态',
    chip?.props?.['data-engine'] === 'microsoft' && chip?.props?.['aria-expanded'] === 'false',
    JSON.stringify({ engine: chip?.props?.['data-engine'], expanded: chip?.props?.['aria-expanded'] }),
  );
  check('下拉：标签带小三角提示可点开', textOf(chip).includes('▾'), textOf(chip));

  chip.props.onClick();
  tree = render(TranslationCard, props);
  const menu = findNode(tree, (node) => node.props?.['data-menu-kind'] === 'engine');
  check('下拉：点一下展开菜单', menu !== null);
  check(
    '下拉：四个引擎都在',
    ['microsoft', 'google', 'llm', 'auto'].every((id) => findNode(menu, (node) => node.props?.['data-option'] === id) !== null),
    JSON.stringify(textOf(menu)),
  );
  check('下拉：当前引擎被勾选', findNode(menu, (node) => node.props?.['data-option'] === 'microsoft')?.props?.['data-current'] === '1');
  check(
    '下拉：每个选项都带一句说明（点开是想知道该选哪个）',
    textOf(findNode(menu, (node) => node.props?.['data-option'] === 'google')).includes('免费端点'),
  );
  check(
    '下拉：菜单是**卡片的子节点**（在卡片之外会被判成"点了外面"→卡片被收掉）',
    findNode(findNode(tree, (node) => node.props?.['data-translate-card'] === 'card'), (node) => node.props?.['data-menu-kind'] === 'engine') !== null,
  );
  check('下拉：展开态回写到卡片与标签上（样式用）', findNode(tree, (node) => node.props?.['data-translate-card'] === 'card')?.props?.['data-menu'] === '1' && byClass(tree, 'dst-engine')?.props?.['data-open'] === '1');

  findNode(menu, (node) => node.props?.['data-option'] === 'google').props.onClick();
  check('下拉：选中一项回调它的 id', calls.picked.join(',') === 'google', calls.picked.join(','));
  tree = render(TranslationCard, props);
  check('下拉：选中后菜单自动收起', findNode(tree, (node) => node.props?.['data-menu-kind'] === 'engine') === null);
}

{
  // 落点：默认在卡片下方；贴底时翻到上方
  resetMount(TranslationCard);
  const props = { draft: draftOf({}), cardRef: { current: null }, onClose: noop };
  let tree = render(TranslationCard, props);
  byClass(tree, 'dst-engine').props.onClick();
  tree = render(TranslationCard, props);
  const menu = findNode(tree, (node) => node.props?.['data-menu-kind'] === 'engine');
  check(
    '下拉落点：默认落在卡片下方（绝对定位在卡片内，卡片已改成 overflow:visible）',
    menu?.props?.['data-side'] === 'below' && String(menu.props.style.top).includes('100%'),
    JSON.stringify({ side: menu?.props?.['data-side'], style: menu?.props?.style }),
  );

  resetMount(TranslationCard);
  const lowProps = { draft: draftOf({ rect: rect(400, 800, 200, 20) }), cardRef: { current: null }, onClose: noop };
  let low = render(TranslationCard, lowProps);
  byClass(low, 'dst-engine').props.onClick();
  low = render(TranslationCard, lowProps);
  const lowMenu = findNode(low, (node) => node.props?.['data-menu-kind'] === 'engine');
  check(
    '下拉落点：贴底时翻到卡片上方（不被视口切掉）',
    lowMenu?.props?.['data-side'] === 'above' && String(lowMenu.props.style.bottom).includes('100%'),
    JSON.stringify({ side: lowMenu?.props?.['data-side'], style: lowMenu?.props?.style }),
  );
}

{
  // 关闭规则：点卡片别处收起；点菜单/标签内部不许收起（否则 mousedown 关、click 又开 → 闪）
  resetMount(TranslationCard);
  const props = { draft: draftOf({}), cardRef: { current: null }, onClose: noop };
  let tree = render(TranslationCard, props);
  byClass(tree, 'dst-engine').props.onClick();
  tree = render(TranslationCard, props);
  findNode(tree, (node) => node.props?.['data-translate-card'] === 'card').props.onMouseDown({ preventDefault: () => {}, target: { closest: () => null } });
  tree = render(TranslationCard, props);
  check('下拉：点卡片别处收起菜单', findNode(tree, (node) => node.props?.['data-menu-kind'] === 'engine') === null);

  byClass(tree, 'dst-engine').props.onClick();
  tree = render(TranslationCard, props);
  findNode(tree, (node) => node.props?.['data-translate-card'] === 'card').props.onMouseDown({ preventDefault: () => {}, target: { closest: () => ({}) } });
  tree = render(TranslationCard, props);
  check('下拉：点菜单内部不会先关掉（避免闪一下又打开）', findNode(tree, (node) => node.props?.['data-menu-kind'] === 'engine') !== null);
}

// 下拉 → 真的换了引擎发请求（"点了没反应"的验证点：整条链路都要走通）
{
  resetListeners();
  resetCardNode();
  // 测试台的 hook 状态按组件函数保留：上一块用例结束时菜单是展开的，
  // 这里必须把卡片实例也重置，否则"点一下"是收起而不是展开
  resetMount(TranslationCard);
  resetMount(TranslateOverlay);
  resetHttp();
  resetStorage();
  api.resetTransport();

  setSelection(sidebarSelection('pick me'));
  let tree = render(TranslateOverlay, {});
  fire('mouseup');
  flushTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslateOverlay, {});
  check('浮层级切换：默认请求微软翻译', JSON.parse(String(http.calls[0].init.body)).engine === 'microsoft', String(http.calls[0].init.body));

  byClass(tree, 'dst-engine').props.onClick();
  tree = render(TranslateOverlay, {});
  const menu = findNode(tree, (node) => node.props?.['data-menu-kind'] === 'engine');
  check('浮层级切换：点标签弹出菜单', menu !== null);

  // 让这一轮的响应来自 Google，便于断言"标签换了"
  http.body = { state: 'done', text: '谷歌译文', target: 'zh-CN', engine: { id: 'google', label: 'Google 翻译' }, elapsedMs: 120 };
  findNode(menu, (node) => node.props?.['data-option'] === 'google').props.onClick();
  tree = render(TranslateOverlay, {});
  const engines = http.calls.map((row) => {
    try {
      return JSON.parse(String(row.init.body)).engine;
    } catch (error) {
      return row.url;
    }
  });
  check('浮层级切换：选中后确实发出了新请求（engine=google）', engines.includes('google'), JSON.stringify(engines));
  check('浮层级切换：偏好被记住（下次划词直接用 Google）', api.readEnginePreference() === 'google', api.readEnginePreference());
  check('浮层级切换：切换期间不显示"翻译中…"（旧译文留着）', textOf(byClass(tree, 'dst-target')) !== '翻译中…', textOf(byClass(tree, 'dst-target')));

  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslateOverlay, {});
  check('浮层级切换：落地后标签显示新引擎', textOf(byClass(tree, 'dst-engine')).includes('Google'), textOf(byClass(tree, 'dst-engine')));
  resetStorage();
}
{
  const truncated = renderCard(draftOf({ truncated: true }));
  check('截断：底部说明选区被截断', textOf(byClass(truncated, 'dst-hint')).includes('仅取前一段'), textOf(byClass(truncated, 'dst-hint')));
}

// 复制
{
  clipboard.text = null;
  clipboard.fail = false;
  let tree = renderCard(draftOf({ result: { state: 'done', text: '译文内容', target: 'zh-CN', engine: 'test' } }));
  byClass(tree, 'dst-copy').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslationCard, { draft: draftOf({ result: { state: 'done', text: '译文内容', target: 'zh-CN', engine: 'test' } }), cardRef: { current: null }, onClose: noop });
  check('复制：写进了剪贴板', clipboard.text === '译文内容', String(clipboard.text));
  check('复制：按钮反馈变成「已复制」', textOf(byClass(tree, 'dst-copy')) === '已复制', textOf(byClass(tree, 'dst-copy')));

  clipboard.fail = true;
  resetMount(TranslationCard);
  let failed = render(TranslationCard, { draft: draftOf({ result: { state: 'done', text: 'x', target: 'zh-CN', engine: 'test' } }), cardRef: { current: null }, onClose: noop });
  byClass(failed, 'dst-copy').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  failed = render(TranslationCard, { draft: draftOf({ result: { state: 'done', text: 'x', target: 'zh-CN', engine: 'test' } }), cardRef: { current: null }, onClose: noop });
  check('复制：剪贴板被拒时不崩、也不谎报成功', byClass(failed, 'dst-copy')?.props?.disabled === false && textOf(byClass(failed, 'dst-copy')) === '复制译文', textOf(byClass(failed, 'dst-copy')));
  clipboard.fail = false;
}

// ----------------------------------------------------------------- 浮层接线（划词 → 弹卡）

/**
 * 右栏里的选区：closest 会命中右栏那组属性。
 *
 * `sessionId` 传了的话，元素的祖先链上就带 `data-sidebar-right-session`
 * ——宿主据此跟随"当前对话的模型"（A 方案）。
 */
function sidebarSelection(text, sessionId) {
  const owner = {
    nodeType: 1,
    getAttribute: (name) => (name === 'data-sidebar-right-session' && sessionId !== undefined ? sessionId : null),
    parentElement: null,
  };
  const element = {
    nodeType: 1,
    closest: (query) => (query.includes('[data-sidebar-right-session]') ? { tag: 'panel' } : null),
    getAttribute: () => null,
    parentElement: owner,
  };
  return selectionOn(element, text, rect(120, 260, 220, 18));
}

/** 对话区里的选区：closest 什么都命中不了。 */
function conversationSelection(text) {
  const element = { nodeType: 1, closest: () => null };
  return selectionOn(element, text, rect(10, 10, 120, 18));
}

/**
 * 可变的"选区矩形 + 存活状态"（定义在文件上方，见 anchorState）。
 */
function selectionOn(element, text, box) {
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    anchorNode: element,
    focusNode: element,
    getRangeAt: () => makeRange(),
  };
}

{
  resetListeners();
  resetCardNode();
  resetMount(TranslateOverlay);
  // 这一块断言 http.calls[0] 的内容，必须自己清干净请求记录与运输方式记忆
  resetHttp();
  api.resetTransport();
  api.writeEnginePreference('microsoft');

  const cardOf = (tree) => findNode(tree, (node) => node.props?.['data-translate-card'] === 'card');

  let tree = render(TranslateOverlay, {});
  check('浮层：没有选区时渲染 null（不留空壳）', tree === null, JSON.stringify(tree));
  check('浮层：挂载后开始监听文档事件（mouseup / selectionchange）', listenerCount('mouseup') > 0 && listenerCount('selectionchange') > 0, `mouseup=${listenerCount('mouseup')} selectionchange=${listenerCount('selectionchange')}`);

  // ① 在右栏里划完一段话
  setSelection(sidebarSelection('Hello from the sidebar.'));
  fire('mouseup');
  flushTimers();
  tree = render(TranslateOverlay, {});
  check('接线：划词后卡片出现', cardOf(tree) !== null);
  check('接线：卡片里就是选中的原文', textOf(byClass(tree, 'dst-source')) === 'Hello from the sidebar.', textOf(byClass(tree, 'dst-source')));
  check('接线：先以 loading 态立起卡片（用户立刻有反馈）', cardOf(tree)?.props?.['data-state'] === 'loading', String(cardOf(tree)?.props?.['data-state']));

  // ② 引擎结果落地（测试台的 fetch 桩返回拿到的 done 结果）
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslateOverlay, {});
  check('接线：引擎结果落地后切到 done 态', cardOf(tree)?.props?.['data-state'] === 'done', String(cardOf(tree)?.props?.['data-state']));
  check('接线：译文进了译文区', textOf(byClass(tree, 'dst-target')) === http.body.text, textOf(byClass(tree, 'dst-target')));
  check('接线：发出去的请求打到宿主路由', http.calls.length >= 1 && http.calls[0].url === api.API_PATH, JSON.stringify(http.calls.map((row) => row.url)));
  check(
    '接线：请求体只有 text / target / engine（凭据不进浏览器）',
    (() => {
      const body = JSON.parse(String(http.calls[0].init.body));
      return (
        Object.keys(body).sort().join(',') === 'engine,source,target,text' &&
        body.text === 'Hello from the sidebar.' &&
        body.target === 'zh-CN' &&
        body.source === 'auto' &&
        body.engine === api.DEFAULT_ENGINE
      );
    })(),
    String(http.calls[0].init.body),
  );
  check('接线：落地后原文仍在（没有被结果覆盖）', textOf(byClass(tree, 'dst-source')) === 'Hello from the sidebar.');

  // ③ 卡片正显示时去对话区划词 —— 必须收起，而不是换内容（这条才是作用域判定的真验证）
  setSelection(conversationSelection('conversation text'));
  fire('mouseup');
  flushTimers();
  tree = render(TranslateOverlay, {});
  check('接线：对话区划词时已弹出的卡片会收起（不换成对话区的内容）', tree === null, JSON.stringify(tree));

  // ④ 回到右栏再划一次：状态没有粘住
  setSelection(sidebarSelection('second pick'));
  fire('mouseup');
  flushTimers();
  tree = render(TranslateOverlay, {});
  check('接线：收起后再次划词仍会弹出，且内容是新的', textOf(byClass(tree, 'dst-source')) === 'second pick', textOf(byClass(tree, 'dst-source')));

  // ⑤ 键盘出口
  fire('keyup', { key: 'Escape' });
  tree = render(TranslateOverlay, {});
  check('接线：Escape 收起卡片', tree === null, JSON.stringify(tree));
}

// 过期结果不能覆盖新一轮选区
{
  const calls = [];
  const setDraft = (next) => {
    calls.push(next);
  };
  api.beginTranslation({ text: 'alpha', truncated: true, rect: ANCHOR }, setDraft);
  check(
    '过期保护：先以 loading 立起卡片，并带上截断标记与方向',
    calls.length === 1 && calls[0].result.state === 'loading' && calls[0].text === 'alpha' && calls[0].truncated === true && calls[0].target === 'zh-CN',
    JSON.stringify(calls[0]),
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  check('过期保护：结果以函数式更新落地（好做身份比对）', calls.length === 2 && typeof calls[1] === 'function');

  // "同一轮"的定义是 requestId 相同（文本一致但引擎/方向不同就不是同一轮）
  const pending = calls[0];
  const same = Object.assign({}, pending);
  const merged = calls[1](same);
  check('过期保护：同一轮（requestId 一致）→ 结果并进草稿', merged !== same && merged.result.state === 'done' && merged.text === 'alpha', JSON.stringify(merged.result));

  const other = { text: 'beta', truncated: false, rect: ANCHOR, target: 'zh-CN', requestId: pending.requestId + 1, result: { state: 'loading', text: '' } };
  check('过期保护：文本已变（另一轮）→ 结果被丢弃（原对象返回）', calls[1](other) === other);
  const sameTextOtherRound = Object.assign({}, pending, { requestId: pending.requestId + 2 });
  check('过期保护：文本相同但不是同一轮 → 一样丢弃', calls[1](sameTextOtherRound) === sameTextOtherRound);
  check('过期保护：卡片已关（null）→ 结果不复活卡片', calls[1](null) === null);
  check('过期保护：每轮都领到新的 requestId', typeof pending.requestId === 'number' && pending.requestId > 0, String(pending.requestId));
}

// ----------------------------------------------------------------- 语言选择与宿主响应解读

{
  check('语言：默认值是 自动检测 → 中文', api.DEFAULT_SOURCE === 'auto' && api.DEFAULT_TARGET === 'zh-CN');
  check(
    '语言：显示名（源语言的 auto 是"自动检测"，不是"自动"）',
    api.sourceLabelOf('auto') === '自动检测' && api.sourceLabelOf('ja') === '日语' && api.targetLabelOf('en') === '英语',
    `${api.sourceLabelOf('auto')} / ${api.sourceLabelOf('ja')} / ${api.targetLabelOf('en')}`,
  );
  check('语言：目标语言的 auto 也按中文兜底（它不该出现，但不能显示成"自动"）', api.targetLabelOf('auto') === '中文', api.targetLabelOf('auto'));
  check('语言：认不出来的代码原样显示（便于排查）', api.languageLabelOf('xx') === 'xx', api.languageLabelOf('xx'));
  check(
    '语言：源语言列表比目标语言多一个 auto，且目标语言里没有 auto',
    api.SOURCE_LANGUAGES[0] === 'auto' && api.SOURCE_LANGUAGES.length === api.TARGET_LANGUAGES.length + 1 && api.TARGET_LANGUAGES.indexOf('auto') === -1,
  );
  check('语言：列表里都是已知语言（不会给出显示不出来的代码）', api.TARGET_LANGUAGES.every((code) => api.languageLabelOf(code) !== code));
  check('语言：语种覆盖足够（≥70 门）', api.TARGET_LANGUAGES.length >= 70, String(api.TARGET_LANGUAGES.length));
  check('语言：代码不重复', new Set(api.TARGET_LANGUAGES).size === api.TARGET_LANGUAGES.length, String(api.TARGET_LANGUAGES.length));
  check(
    '语言：常见语种都在（英日韩法德西俄阿泰越 + 瑞典/乌克兰/希伯来/印地/印尼）',
    ['en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'ar', 'th', 'vi', 'sv', 'uk', 'he', 'hi', 'id'].every((code) => api.TARGET_LANGUAGES.indexOf(code) !== -1),
  );
  check(
    '语言：客户端语言表与宿主 LANGUAGE_NAMES 的键集合完全一致（漂移会让模型那路译错语言）',
    api.TARGET_LANGUAGES.slice().sort().join(',') === Object.keys(LANGUAGE_NAMES).sort().join(','),
    (() => {
      const host = Object.keys(LANGUAGE_NAMES);
      const only = (list, other) => list.filter((code) => other.indexOf(code) === -1);
      return `客户端多出=${JSON.stringify(only(api.TARGET_LANGUAGES, host))} 宿主多出=${JSON.stringify(only(host, api.TARGET_LANGUAGES))}`;
    })(),
  );

  // 偏好：选过的语言要记住（否则每次划词都得重选）
  resetStorage();
  check('语言偏好：默认源 auto / 目标 zh-CN', api.readSourcePreference() === 'auto' && api.readTargetPreference() === 'zh-CN');
  api.writeSourcePreference('ja');
  api.writeTargetPreference('en');
  check('语言偏好：写进去能读回来', api.readSourcePreference() === 'ja' && api.readTargetPreference() === 'en');
  localStorage.setItem('dsh-translate:source', 'klingon');
  check('语言偏好：坏值（不在列表里）回落默认', api.readSourcePreference() === 'auto', api.readSourcePreference());
  localStorage.removeItem('dsh-translate:target');
  check('语言偏好：缺失回落默认', api.readTargetPreference() === 'zh-CN');
  resetStorage();

  const done = api.interpretResponse(200, { state: 'done', text: 'hi', target: 'en', engine: { model: 'm' }, elapsedMs: 5, cached: true }, 'zh-CN');
  check('解读：done 响应原样收敛', done.state === 'done' && done.text === 'hi' && done.cached === true && done.elapsedMs === 5);
  const failed = api.interpretResponse(502, { state: 'error', error: '限流', code: 'RATE_LIMIT' }, 'zh-CN');
  check('解读：error 响应带上 code（卡片不显示 code，但程序要能分流）', failed.state === 'error' && failed.code === 'RATE_LIMIT' && failed.error === '限流');
  check('解读：非 JSON 响应给可读提示而不是崩', api.interpretResponse(502, null, 'zh-CN').code === 'BAD_RESPONSE');
  check('解读：done 但文本为空时按失败处理', api.interpretResponse(200, { state: 'done', text: '' }, 'zh-CN').state === 'error');
}

{
  api.resetTransport();
  resetHttp();
  const ok = await api.requestTranslation({ text: 'Hello', target: 'zh-CN' });
  check('请求：成功路径', ok.state === 'done' && ok.text === http.body.text, JSON.stringify(ok));
  check('请求：默认走 POST', http.calls.length === 1 && http.calls[0].init.method === 'POST', JSON.stringify(http.calls.map((row) => row.init.method)));

  api.resetTransport();
  resetHttp();
  http.mode = 'reject';
  const unreachable = await api.requestTranslation({ text: 'Hello' });
  check('请求：宿主不可达时不谎报"路由不存在"', unreachable.state === 'error' && unreachable.code === 'UNREACHABLE', unreachable.code);

  api.resetTransport();
  resetHttp();
  http.mode = 'bad-json';
  http.status = 502;
  const bad = await api.requestTranslation({ text: 'Hello' });
  check('请求：路由在但响应不可解析时，报"请求拿不到响应"而不是"路由不存在"', bad.state === 'error' && bad.code === 'ROUTE_REJECTED', `${bad.code}: ${bad.error}`);

  api.resetTransport();
  resetHttp();
  http.mode = 'bad-json';
  http.healthBody = null;
  const noRoute = await api.requestTranslation({ text: 'Hello' });
  check('请求：健康检查也不通时报"路由不存在"', noRoute.state === 'error' && noRoute.code === 'NO_ROUTE', `${noRoute.code}: ${noRoute.error}`);

  api.resetTransport();
  resetHttp();
  http.status = 502;
  http.body = { state: 'error', error: '账号余额不足', code: 'ACCOUNT_QUOTA' };
  const quota = await api.requestTranslation({ text: 'Hello' });
  check('请求：业务失败按 502 解读成 error 结果', quota.state === 'error' && quota.code === 'ACCOUNT_QUOTA' && quota.error === '账号余额不足');
  resetHttp();
}

// 运输方式回退（桌面版：非 GET 的未匹配请求会被 SPA 兜底回答 405）
{
  api.resetTransport();
  resetHttp();
  http.mode = 'method-blocked';
  const failed = await api.requestTranslation({ text: 'Hello', target: 'zh-CN' });
  check('回退：POST 被 405 拦下时自动改用 GET 并成功', failed.state === 'done' && failed.text === http.body.text, JSON.stringify(failed));
  check(
    '回退：请求序列 = POST → 健康检查 → GET（同一次翻译）',
    http.calls.length === 3 &&
      http.calls[0].init.method === 'POST' &&
      http.calls[1].url.includes('/health') &&
      http.calls[2].init.method === 'GET',
    JSON.stringify(http.calls.map((row) => row.init.method + ' ' + row.url)),
  );
  const translateGets = http.calls.filter((row) => row.url.includes('/translate') && row.init.method === 'GET');
  check(
    '回退：GET 把 text/target 放进查询串',
    translateGets.length === 1 && translateGets[0].url.includes('?text=Hello') && translateGets[0].url.includes('target=zh-CN'),
    translateGets.map((row) => row.url).join(' | '),
  );

  // 记住 GET：下一次不再先撞一次 POST
  resetHttp();
  http.mode = 'method-blocked';
  const again = await api.requestTranslation({ text: 'Second', target: 'zh-CN' });
  check('回退：记住 GET 之后下一次直接 GET（省一次 405）', again.state === 'done' && http.calls.length === 1 && http.calls[0].init.method === 'GET', JSON.stringify(http.calls.map((row) => row.init.method)));

  // 路由根本不存在：必须给出"重启 DSH"的可执行错误，并且只探一次健康检查
  api.resetTransport();
  resetHttp();
  http.mode = 'route-missing';
  const missing = await api.requestTranslation({ text: 'Hello', target: 'zh-CN' });
  check('回退：路由不存在时错误码是 NO_ROUTE', missing.state === 'error' && missing.code === 'NO_ROUTE', `${missing.code}: ${missing.error}`);
  check('回退：错误文案点名"重启 DSH"（刷新页面不够）', missing.error.includes('重启 DSH') && missing.error.includes('刷新页面'), missing.error);
  const healthCalls = http.calls.filter((row) => row.url.includes('/health')).length;
  check('回退：健康检查只探一次', healthCalls === 1, String(healthCalls));

  resetHttp();
  http.mode = 'route-missing';
  await api.requestTranslation({ text: 'Another', target: 'zh-CN' });
  check('回退：探测结果被缓存（不再重复探测）', http.calls.filter((row) => row.url.includes('/health')).length === 0, JSON.stringify(http.calls.map((row) => row.url)));

  // 超长选区装不进 GET：不做回退，给出可读原因
  api.resetTransport();
  resetHttp();
  http.mode = 'method-blocked';
  const long = await api.requestTranslation({ text: 'x'.repeat(api.GET_TEXT_LIMIT + 1), target: 'zh-CN' });
  check('回退：超长选区不走 GET（URL 装不下）', long.state === 'error' && long.code === 'ROUTE_REJECTED', `${long.code}: ${long.error}`);
  check('回退：超长时不产生第二次请求', http.calls.filter((row) => row.init.method === 'GET' && row.url.includes('/translate')).length === 0, JSON.stringify(http.calls.map((row) => row.init.method)));
  check('回退：canUseGet 的边界', api.canUseGet('x'.repeat(api.GET_TEXT_LIMIT)) === true && api.canUseGet('x'.repeat(api.GET_TEXT_LIMIT + 1)) === false);
  check('回退：canUseGet 拒绝空文本', api.canUseGet('') === false);

  api.resetTransport();
  resetHttp();
}

// 引擎选择（客户端侧：默认值、偏好、循环、随请求发出）
{
  resetStorage();
  check('引擎：默认是微软翻译（用户指定的默认，不是 auto）', api.DEFAULT_ENGINE === 'microsoft' && api.readEnginePreference() === 'microsoft', api.readEnginePreference());
  check(
    '引擎：循环顺序是 微软 → Google → 模型 → 自动 → 微软',
    api.ENGINE_CYCLE.join(',') === 'microsoft,google,llm,auto',
    api.ENGINE_CYCLE.join(','),
  );
  check(
    '引擎：nextEngine 首尾相接',
    api.nextEngine('microsoft') === 'google' &&
      api.nextEngine('google') === 'llm' &&
      api.nextEngine('llm') === 'auto' &&
      api.nextEngine('auto') === 'microsoft',
    api.ENGINE_CYCLE.map((id) => id + '→' + api.nextEngine(id)).join(' '),
  );
  check('引擎：显示名与宿主侧一致', api.engineLabelOf('microsoft') === '微软翻译' && api.engineLabelOf('google') === 'Google 翻译' && api.engineLabelOf('llm') === '模型');
  check('引擎：认不出的 id 原样显示（便于发现配置写错）', api.engineLabelOf('baidu') === 'baidu', api.engineLabelOf('baidu'));

  // 偏好：写进去要能读出来；未选过时默认 auto
  api.writeEnginePreference('google');
  check('引擎：偏好写读一致', api.readEnginePreference() === 'google', api.readEnginePreference());
  api.writeEnginePreference('baidu');
  check('引擎：非法偏好不会被写进去', api.readEnginePreference() === 'google', api.readEnginePreference());
  api.writeEnginePreference('auto');

  // 指定引擎时请求要带上它（POST 与 GET 两条运输方式都要带）
  api.resetTransport();
  resetHttp();
  const picked = await api.requestTranslation({ text: 'Hello', target: 'zh-CN', engine: 'google' });
  check('引擎：指定引擎时成功返回', picked.state === 'done', JSON.stringify(picked).slice(0, 120));
  check('引擎：POST body 带上 engine', JSON.parse(String(http.calls[0].init.body)).engine === 'google', String(http.calls[0].init.body));

  api.resetTransport();
  resetHttp();
  http.mode = 'method-blocked';
  await api.requestTranslation({ text: 'Hello', target: 'zh-CN', engine: 'microsoft' });
  const getCall = http.calls.filter((row) => row.url.includes('/translate') && row.init.method === 'GET')[0];
  check('引擎：回退到 GET 时 engine 进查询串', getCall !== undefined && getCall.url.includes('engine=microsoft'), getCall?.url);

  // 没指定引擎时用偏好；偏好是 auto 时 body 里是 auto
  api.resetTransport();
  resetHttp();
  api.writeEnginePreference('llm');
  await api.requestTranslation({ text: 'Hello', target: 'zh-CN' });
  check('引擎：未指定时用已保存的偏好', JSON.parse(String(http.calls[0].init.body)).engine === 'llm', String(http.calls[0].init.body));
  api.writeEnginePreference('auto');
  api.resetTransport();
  resetHttp();
}

// ----------------------------------------------------------------- 锚点（滚动的正确行为）

{
  const live = makeRange();
  check('锚点（文档）：活 Range 能算出矩形', (() => {
    const anchor = api.rangeAnchor(live);
    const out = api.rectOfAnchor(anchor);
    return out !== null && out.left === 120 && out.top === 260 && out.width === 220;
  })());
  check('锚点（文档）：锚点跟着 DOM 走（矩形变了，重算就得到新位置）', (() => {
    const anchor = api.rangeAnchor(makeRange());
    anchorState.box = rect(120, 500, 220, 18);
    const out = api.rectOfAnchor(anchor);
    return out !== null && out.top === 500;
  })(), JSON.stringify(api.rectOfAnchor(api.rangeAnchor(makeRange()))));
  check('锚点（文档）：选区节点断开后返回 null（调用方据此收起）', (() => {
    anchorState.connected = false;
    const out = api.rectOfAnchor(api.rangeAnchor(makeRange()));
    anchorState.connected = true;
    return out === null;
  })());
  check('锚点（文档）：没有 cloneRange 能力时安全降级为 null', api.rangeAnchor({ getBoundingClientRect: () => rect(0, 0, 1, 1) }) === null);

  const element = { isConnected: true, getBoundingClientRect: () => rect(600, 100, 400, 600), getZoomFactor: () => 2 };
  check('锚点（浏览器）：用元素当前位置 + guest 局部矩形合成', (() => {
    const anchor = api.guestAnchor(element, rect(40, 60, 120, 16), 2);
    const out = api.rectOfAnchor(anchor);
    return out !== null && out.left === 680 && out.top === 220 && out.width === 240;
  })());
  check('锚点（浏览器）：webview 元素被卸载后返回 null', (() => {
    const gone = { isConnected: false, getBoundingClientRect: () => rect(0, 0, 0, 0), getZoomFactor: () => 1 };
    return api.rectOfAnchor(api.guestAnchor(gone, rect(1, 1, 2, 2), 1)) === null;
  })());
  check('锚点：认不出的锚点类型返回 null（不猜）', api.rectOfAnchor({ kind: 'mystery' }) === null && api.rectOfAnchor(null) === null);
}

// ----------------------------------------------------------------- 切换时不闪白（旧译文留在原位）

{
  const previous = { state: 'done', text: '旧译文', target: 'zh-CN', engine: { id: 'microsoft', label: '微软翻译' }, elapsedMs: 300 };
  const tree = renderCard(
    draftOf({ result: { state: 'loading', text: '', target: 'zh-CN', engine: null }, previous: previous, engine: 'google' }),
  );
  const target = byClass(tree, 'dst-target');
  check('更新中：旧译文留在原位（不再清空成"翻译中…"）', textOf(target) === '旧译文', textOf(target));
  check('更新中：带 data-stale 标记（样式把它变淡）', target?.props?.['data-stale'] === '1', String(target?.props?.['data-stale']));
  check('更新中：引擎标签说"更新中…"（这才是状态该出现的地方）', textOf(byClass(tree, 'dst-engine')).includes('更新中'), textOf(byClass(tree, 'dst-engine')));
  check('更新中：眼前的旧译文仍可复制', byClass(tree, 'dst-copy')?.props?.disabled === false);
}
{
  const tree = renderCard(draftOf({ result: { state: 'loading', text: '', target: 'zh-CN', engine: null } }));
  check('首次加载：没有旧译文时仍显示"翻译中…"', textOf(byClass(tree, 'dst-target')) === '翻译中…', textOf(byClass(tree, 'dst-target')));
}

{
  // rerunDraft 必须把"上一版译文"和"锚点"一起带过去：前者防闪白，后者让滚过之后仍能跟随
  const calls = [];
  const anchor = { kind: 'range', range: makeRange() };
  const previous = { state: 'done', text: '旧', engine: null };
  api.rerunDraft(
    { text: 'hi', truncated: false, rect: ANCHOR, target: 'zh-CN', manual: false, engine: 'microsoft', anchor: anchor, result: previous },
    (next) => calls.push(next),
    { engine: 'google' },
  );
  check('重跑：带上上一版译文（切换引擎/方向不闪白）', calls[0]?.previous === previous, JSON.stringify(calls[0]?.previous));
  check('重跑：沿用锚点（滚过之后仍能跟随）', calls[0]?.anchor === anchor);
  check('重跑：引擎换成指定值、方向与文本保持不变', calls[0]?.engine === 'google' && calls[0]?.target === 'zh-CN' && calls[0]?.text === 'hi');
}

// ----------------------------------------------------------------- 浮层：滚动重定位而不是消失

{
  resetListeners();
  resetCardNode();
  resetMount(TranslateOverlay);
  anchorState.box = rect(120, 260, 220, 18);
  anchorState.connected = true;

  let tree = render(TranslateOverlay, {});
  setSelection(sidebarSelection('scroll me'));
  fire('mouseup');
  flushTimers();
  tree = render(TranslateOverlay, {});
  const cardOf = (node) => findNode(node, (row) => row.props?.['data-translate-card'] === 'card');
  const before = cardOf(tree)?.props?.style?.top;
  check('滚动接线：卡片先出现', cardOf(tree) !== null && before !== undefined, String(before));

  // 模拟"在被预览的文档里往下翻"：选区矩形下移，然后滚一下
  anchorState.box = rect(120, 520, 220, 18);
  fire('scroll', { target: { nodeType: 1 } });
  tree = render(TranslateOverlay, {});
  const after = cardOf(tree)?.props?.style?.top;
  check('滚动接线：卡片跟着选区走（不再一滚就消失）', cardOf(tree) !== null && after !== before, `${before} → ${after}`);
  check('滚动接线：新位置正是新选区的正下方', Number.parseFloat(after) === 520 + 18 + api.CARD_GAP, String(after));

  // 选区失效（节点断开）→ 这次才收起
  anchorState.connected = false;
  fire('scroll', { target: { nodeType: 1 } });
  tree = render(TranslateOverlay, {});
  check('滚动接线：锚点失效后才收起', tree === null, JSON.stringify(tree));
  anchorState.connected = true;
}

// 回归：点菜单选项时必须"算在卡片内部"，否则 mousedown 会先把卡片收掉
// （这就是用户报的"点击其他翻译后弹窗直接消失了"）
{
  resetListeners();
  resetCardNode();
  resetMount(TranslationCard);
  resetMount(TranslateOverlay);
  resetHttp();
  resetStorage();
  api.resetTransport();

  setSelection(sidebarSelection('switch me'));
  let tree = render(TranslateOverlay, {});
  fire('mouseup');
  flushTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslateOverlay, {});

  byClass(tree, 'dst-engine').props.onClick();
  tree = render(TranslateOverlay, {});
  const option = findNode(tree, (node) => node.props?.['data-option'] === 'google');
  check('回归：下拉已展开且选项存在', option !== null);

  // 让"卡片包含哪些节点"这个判断像真实 DOM 一样生效：
  // 真实浏览器里 mousedown 的 target 是卡片子树内的元素
  const inside = new Set();
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    inside.add(node);
    (node.children ?? []).forEach(walk);
  })(findNode(tree, (node) => node.props?.['data-translate-card'] === 'card'));
  cardNode.contains = (element) => inside.has(element);

  fire('mousedown', { target: option });
  const afterPress = render(TranslateOverlay, {});
  check('回归：在菜单选项上按下不会收起卡片（菜单算卡片内部）', afterPress !== null, JSON.stringify(afterPress));

  http.body = { state: 'done', text: '谷歌译文', target: 'zh-CN', engine: { id: 'google', label: 'Google 翻译' }, elapsedMs: 90 };
  findNode(afterPress, (node) => node.props?.['data-option'] === 'google').props.onClick();
  const switched = render(TranslateOverlay, {});
  check('回归：随后 click 真的切到了 Google', textOf(byClass(switched, 'dst-engine')).includes('Google'), textOf(byClass(switched, 'dst-engine')));
  const engines = http.calls.map((row) => {
    try {
      return JSON.parse(String(row.init.body)).engine;
    } catch (error) {
      return row.url;
    }
  });
  check('回归：并且发出了新引擎的请求', engines.includes('google'), JSON.stringify(engines));
  check('回归：切换过程中卡片一直没消失', switched !== null, JSON.stringify(switched));
  resetStorage();
  resetCardNode();
}

// 竞态回归：先发 Google、再切回微软 —— Google 的失败结果迟到时绝不能顶掉微软的译文
{
  resetListeners();
  resetCardNode();
  resetMount(TranslationCard);
  resetMount(TranslateOverlay);
  resetHttp();
  resetStorage();
  api.resetTransport();

  api.writeEnginePreference('google');
  http.manual = true; // 让用例决定谁先回来（自动桩永远是"先发先回"，构造不出乱序）

  setSelection(sidebarSelection('race case'));
  let tree = render(TranslateOverlay, {});
  fire('mouseup');
  flushTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslateOverlay, {});
  check('竞态：第一个请求发给了 Google', http.pending.length === 1 && http.pending[0].engine === 'google', JSON.stringify(http.pending.map((row) => row.engine)));

  // 切回微软
  byClass(tree, 'dst-engine').props.onClick();
  tree = render(TranslateOverlay, {});
  const menu = findNode(tree, (node) => node.props?.['data-menu-kind'] === 'engine');
  findNode(menu, (node) => node.props?.['data-option'] === 'microsoft').props.onClick();
  tree = render(TranslateOverlay, {});
  check(
    '竞态：切换立刻发出第二个请求（微软），两个请求同时在飞',
    http.pending.length === 2 && http.pending[1].engine === 'microsoft',
    JSON.stringify(http.pending.map((row) => row.engine)),
  );

  // 微软先回来
  http.pending[1].done({ state: 'done', text: '微软译文', target: 'zh-CN', engine: { id: 'microsoft', label: '微软翻译' }, elapsedMs: 120 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslateOverlay, {});
  check('竞态：先回来的微软结果正常显示', textOf(byClass(tree, 'dst-target')) === '微软译文', textOf(byClass(tree, 'dst-target')));

  // Google 的错误结果迟到 —— 这就是用户报的现象：它以前会顶掉微软的译文
  http.pending[0].done({ state: 'error', error: 'Google 翻译 网络不可达：fetch failed', code: 'UNREACHABLE', target: 'zh-CN', engine: { id: 'google', label: 'Google 翻译' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslateOverlay, {});
  check('竞态：迟到的 Google 错误结果被丢弃，微软译文还在', textOf(byClass(tree, 'dst-target')) === '微软译文', textOf(byClass(tree, 'dst-target')));
  check('竞态：卡片也没被拉回错误态', byClass(tree, 'dst-target')?.props?.['data-state'] === 'done', String(byClass(tree, 'dst-target')?.props?.['data-state']));
  check('竞态：引擎标签仍是微软（没被迟到结果改回去）', textOf(byClass(tree, 'dst-engine')).includes('微软'), textOf(byClass(tree, 'dst-engine')));

  // 反向也要成立：切走之后，旧的成功结果同样不许覆盖新的失败态
  api.writeEnginePreference('microsoft');
  http.manual = false;
  resetStorage();
  resetCardNode();
}

// 语言选择（浮层级）：选了源/目标语言要真的重译、要记住、且互不打扰
{
  resetListeners();
  resetCardNode();
  resetMount(TranslationCard);
  resetMount(TranslateOverlay);
  resetHttp();
  resetStorage();
  api.resetTransport();

  setSelection(sidebarSelection('bonjour le monde'));
  let tree = render(TranslateOverlay, {});
  fire('mouseup');
  flushTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslateOverlay, {});

  const bodyOf = (index) => JSON.parse(String(http.calls[index].init.body));
  const first = bodyOf(0);
  check('浮层级语言：默认请求带 source=auto / target=zh-CN', first.source === 'auto' && first.target === 'zh-CN', JSON.stringify(first));

  byClass(tree, 'dst-lang-source').props.onClick();
  tree = render(TranslateOverlay, {});
  const sourceMenu = findNode(tree, (node) => node.props?.['data-menu-kind'] === 'source');
  findNode(sourceMenu, (node) => node.props?.['data-option'] === 'ja').props.onClick();
  tree = render(TranslateOverlay, {});
  const second = bodyOf(http.calls.length - 1);
  check('浮层级语言：选源语言后重译，带上 source=ja 且目标不变', second.source === 'ja' && second.target === 'zh-CN', JSON.stringify(second));
  check('浮层级语言：源语言偏好被记住', api.readSourcePreference() === 'ja', api.readSourcePreference());
  check('浮层级语言：头部标签跟着变成日语', textOf(byClass(tree, 'dst-lang-source')).includes('日语'), textOf(byClass(tree, 'dst-lang-source')));

  // 等这一轮落地（否则草稿还停在 loading，"旧译文仍在"就无从谈起）
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslateOverlay, {});

  byClass(tree, 'dst-lang-target').props.onClick();
  tree = render(TranslateOverlay, {});
  const targetMenu = findNode(tree, (node) => node.props?.['data-menu-kind'] === 'target');
  findNode(targetMenu, (node) => node.props?.['data-option'] === 'en').props.onClick();
  tree = render(TranslateOverlay, {});
  const third = bodyOf(http.calls.length - 1);
  check('浮层级语言：选目标语言后重译，源语言保持日语（两个选择器互不覆盖）', third.target === 'en' && third.source === 'ja', JSON.stringify(third));
  check('浮层级语言：目标语言偏好被记住', api.readTargetPreference() === 'en', api.readTargetPreference());
  check('浮层级语言：重译期间旧译文仍在（不闪白）', textOf(byClass(tree, 'dst-target')) !== '翻译中…', textOf(byClass(tree, 'dst-target')));

  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render(TranslateOverlay, {});
  check('浮层级语言：结果落地后目标标签是英语', textOf(byClass(tree, 'dst-lang-target')).includes('英语'), textOf(byClass(tree, 'dst-lang-target')));
  resetStorage();
  resetCardNode();
}

// 会话 id：跟随"当前对话的模型"靠它（客户端从右栏容器上读）
{
  const root = { nodeType: 1, getAttribute: (name) => (name === 'data-sidebar-right-session' ? 'sess-42' : null), parentElement: null };
  const mid = { nodeType: 1, getAttribute: () => null, parentElement: root };
  const leaf = { nodeType: 1, getAttribute: () => null, parentElement: mid };
  check('会话：能从祖先节点上读到 sessionId（DSH 自己也是这么读的）', api.sessionIdOf(leaf) === 'sess-42', api.sessionIdOf(leaf));
  check('会话：元素自己带属性时直接命中', api.sessionIdOf(root) === 'sess-42', api.sessionIdOf(root));
  check('会话：不在右栏里时返回空串（那就跟随全局默认模型）', api.sessionIdOf({ nodeType: 1, getAttribute: () => null, parentElement: null }) === '');
  check(
    '会话：元素为空 / 属性抛错 / 祖先链异常时不崩',
    api.sessionIdOf(null) === '' &&
      api.sessionIdOf(undefined) === '' &&
      api.sessionIdOf({ nodeType: 1, getAttribute: () => { throw new Error('boom'); }, parentElement: null }) === '',
  );
  check('会话：祖先链很长也不会无限走下去（有护栏）', (() => {
    let node = { nodeType: 1, getAttribute: () => null, parentElement: null };
    for (let i = 0; i < 200; i++) node = { nodeType: 1, getAttribute: () => null, parentElement: node };
    return api.sessionIdOf(node) === '';
  })());
}

// 接线：右栏里划词时，请求带上 sessionId（宿主据此跟随当前对话的模型）
{
  resetListeners();
  resetCardNode();
  resetMount(TranslateOverlay);
  resetHttp();
  resetStorage();
  api.resetTransport();
  api.writeEnginePreference('llm');

  setSelection(sidebarSelection('follow my model', 'sess-42'));
  const tree = render(TranslateOverlay, {});
  fire('mouseup');
  flushTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const body = JSON.parse(String(http.calls[0].init.body));
  check('接线：请求里带上了 sessionId', body.sessionId === 'sess-42', JSON.stringify(body));
  check('接线：其他字段不受影响', body.text === 'follow my model' && body.engine === 'llm' && body.source === 'auto' && body.target === 'zh-CN', JSON.stringify(body));

  // 拿不到会话（不在右栏容器里）时不该带空字段，免得宿主误判
  resetHttp();
  api.resetTransport();
  api.writeEnginePreference('llm');
  setSelection(sidebarSelection('no session here'));
  render(TranslateOverlay, {});
  fire('mouseup');
  flushTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const bare = JSON.parse(String(http.calls[0].init.body));
  check('接线：读不到 sessionId 时不发送这个字段（退回全局默认模型）', bare.sessionId === undefined && Object.keys(bare).sort().join(',') === 'engine,source,target,text', JSON.stringify(bare));
  resetStorage();
}

summary('卡片渲染与浮层接线');

/**
 * 构建脚本：把 `src/client/*.js` 合成 DSH 客户端 bundle `lib/client.js`。
 *
 * ## 为什么需要构建
 *
 * DSH 的浏览器插件 bundle 由 `/plugins/<pkg>/client.js` **原样**送给页面，
 * 不能有顶层 `import` / `export`（页面侧只是个普通脚本 + `window.__ModuleLoader__`）。
 * 所以源码按模块拆开写，构建时合成一个自包含的单文件：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * ## 模块协议
 *
 * 每个 `src/client/*.js` 都是一段**模块体**（不是独立可执行文件）：
 *   · 不能有顶层 import/export；
 *   · 可以引用本模块内声明的名字，以及构建脚本按 `deps` 注入的依赖名；
 *   · 结尾用 `return { ... }` 导出。
 *
 * 依赖关系写在下面的 MODULES 表里，一眼可见；构建时会双向校验
 * （用了没声明、声明了没用、声明了没导出 —— 这三种都是**静默失败**，
 * 构建期拦下来比在页面上查半天便宜）。
 *
 * ## 用法
 *
 *   node scripts/build.mjs            # 生成 lib/client.js
 *   node scripts/build.mjs --check    # 只校验不写文件（测试用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src', 'client');
const OUT = join(ROOT, 'lib', 'client.js');
const CSS_FILE = join(SRC, 'styles', 'client.css');

/** 模块身份：必须等于包名，DSH 按它把 bundle 对到 Loader 条目上。 */
const PACKAGE_ID = 'dsh-translate';

/**
 * 平台能力：由 bundle factory 的 require 提供（React 一定在平台种子表里）。
 *
 * ⚠️ `h` 必须是 **createElement**，不能是 `react/jsx-runtime` 的 `jsx`：
 * 两者签名不同（`jsx(type, props, key)` 的第三个参数是 key），
 * 绑错的话所有 `h('div', props, child)` 的子元素都会被当成 key 丢掉，
 * 表现是"浮窗只有一个空壳"。测试台会直接查产物里这条绑定。
 */
const PLATFORM = {
  react: "require('react')",
  h: "require('react').createElement",
  useState: "require('react').useState",
  useEffect: "require('react').useEffect",
  useLayoutEffect: "require('react').useLayoutEffect",
  useRef: "require('react').useRef",
  useMemo: "require('react').useMemo",
  useCallback: "require('react').useCallback",
};

/** 每个模块对外暴露什么（也用于给消费者生成解构行）。 */
const EXPORTS = {
  geometry: [
    'CARD_WIDTH',
    'CARD_GAP',
    'CARD_MARGIN',
    'MAX_TEXT_CHARS',
    'clamp',
    'normalizeText',
    'clampText',
    'viewportOf',
    'viewportBounds',
    'intersectBounds',
    'boundsOfRect',
    'rectOfRange',
    'placeCard',
    'composeRect',
  ],
  scope: [
    'SCOPE_SELECTORS',
    'SCOPE_QUERY',
    'elementOfNode',
    'isInSidebar',
    'isInsideElement',
    'sessionIdOf',
    'sidebarRectOf',
    'captureDraft',
  ],
  translate: [
    'API_PATH',
    'HEALTH_PATH',
    'GET_TEXT_LIMIT',
    'TRANSPORT_POST',
    'TRANSPORT_GET',
    'ENGINE_CYCLE',
    'ENGINE_LABELS',
    'DEFAULT_ENGINE',
    'SOURCE_LANGUAGES',
    'TARGET_LANGUAGES',
    'DEFAULT_SOURCE',
    'DEFAULT_TARGET',
    'AUTO_SOURCE_LABEL',
    'REQUEST_TIMEOUT_MS',
    'LANGUAGE_LABELS',
    'languageLabelOf',
    'sourceLabelOf',
    'targetLabelOf',
    'readSourcePreference',
    'writeSourcePreference',
    'readTargetPreference',
    'writeTargetPreference',
    'loadingResult',
    'errorResult',
    'describeError',
    'interpretResponse',
    'resetTransport',
    'canUseGet',
    'sendOnce',
    'readEnginePreference',
    'writeEnginePreference',
    'nextEngine',
    'engineLabelOf',
    'requestTranslation',
    'mergeResult',
  ],
  styles: ['STYLE_TAG', 'cssText', 'installCss'],
  diag: ['DIAG_PATH', 'digest', 'rectBrief', 'elementBrief', 'reportDiag'],
  anchor: ['rangeAnchor', 'guestAnchor', 'elementRect', 'zoomFactorFor', 'rectOfAnchor'],
  selection: ['createWatcher'],
  'guest-bridge': [
    'WEBVIEW_SELECTOR',
    'POLL_INTERVAL_MS',
    'MAX_QUEUE',
    'GUEST_INSTALL_SCRIPT',
    'GUEST_POLL_SCRIPT',
    'createGuestBridge',
  ],
  popup: ['TranslationCard', 'TranslateOverlay', 'beginTranslation', 'rerunDraft', 'viewOf', 'engineChipText', 'engineIdOf', 'hintOf'],
  plugin: [],
};

/**
 * 模块清单。顺序 = 初始化顺序，依赖必须排在消费者之前。
 * deps 里的 `@platform` 表示需要 React 能力；其它名字是模块名。
 */
const MODULES = [
  { name: 'geometry', file: 'geometry.js', deps: [], what: '弹窗几何与文本规整（纯函数，可单测）' },
  { name: 'scope', file: 'scope.js', deps: [], what: '作用域判定：只认右侧栏，并排除卡片自身' },
  { name: 'translate', file: 'translate.js', deps: [], what: '客户端引擎接缝：方向/引擎选择、宿主调用、运输方式回退' },
  { name: 'styles', file: 'styles.js', deps: [], what: '样式注入（CSS 文本在 styles/client.css）' },
  { name: 'diag', file: 'diag.js', deps: [], what: '诊断上报：把客户端观测值送回宿主，暴露在 /health' },
  { name: 'anchor', file: 'anchor.js', deps: ['geometry'], what: '选区锚点：滚动/改窗口后重新算卡片落点（锚点失效才收起）' },
  { name: 'selection', file: 'selection.js', deps: ['scope', 'geometry', 'diag'], what: '选区监听器（事件时序集中在这里）' },
  {
    name: 'guest-bridge',
    file: 'guest-bridge.js',
    deps: ['geometry', 'anchor', 'scope', 'diag'],
    what: '侧栏浏览器选区桥（executeJavaScript 注入 + 轮询取事件）',
  },
  {
    name: 'popup',
    file: 'popup.js',
    deps: ['@platform', 'geometry', 'scope', 'translate', 'selection', 'guest-bridge', 'anchor', 'diag'],
    what: '翻译卡片与浮层组件（文档选区与浏览器选区两条来源）',
  },
  {
    name: 'plugin',
    file: 'plugin.js',
    deps: ['@platform', 'styles', 'popup', 'geometry', 'scope', 'selection', 'translate', 'guest-bridge', 'anchor', 'diag'],
    what: '插件入口：槽位注册、样式与生命周期',
  },
];

/** 产物头部注释里的模块清单（由 MODULES 生成，宽度按最长文件名对齐）。 */
function moduleListComment() {
  const width = Math.max(...MODULES.map((spec) => spec.file.length));
  return MODULES.map((spec) => ` *   ${spec.file.padEnd(width)}  ${spec.what}`).join('\n');
}

/** 读模块体，并把 CSS 与版本号占位符替换成真实值。 */
function readModule(spec, css, version) {
  const raw = readFileSync(join(SRC, spec.file), 'utf8');
  if (/^\s*import\s/m.test(raw)) throw new Error(`${spec.file}: 模块体不能有顶层 import`);
  if (/^\s*export\s/m.test(raw)) throw new Error(`${spec.file}: 模块体不能有顶层 export`);
  const body = raw.replace(/__CSS_TEXT__/g, JSON.stringify(css)).replace(/__PACKAGE_VERSION__/g, JSON.stringify(version)).trim();
  // 语法检查：模块体就是函数体（结尾是 return {...}），所以能用 Function 编译。
  // ⚠️ 这条守卫是补上来的：构建只做字符串拼接时，一个多余的分号可以一路编译到
  // 页面里，报错却指向"产物第 1866 行"这种没用的位置 —— 现在直接点名文件。
  try {
    new Function(body);
  } catch (error) {
    throw new Error(`${spec.file}: 语法错误 —— ${error instanceof Error ? error.message : String(error)}`);
  }
  return body;
}

/** 生成依赖声明行。 */
function depLines(spec) {
  const lines = [];
  if (spec.deps.includes('@platform')) {
    for (const name of Object.keys(PLATFORM)) lines.push(`var ${name} = ${PLATFORM[name]};`);
  }
  for (const dep of spec.deps) {
    if (dep === '@platform') continue;
    const exported = EXPORTS[dep];
    if (exported === undefined) throw new Error(`${spec.name}: 未知依赖 ${dep}`);
    if (exported.length === 0) continue;
    const alias = dep.replace(/-/g, '_');
    lines.push(`var ${alias} = R(${JSON.stringify(dep)});`);
    for (const key of exported) lines.push(`var ${key} = ${alias}.${key};`);
  }
  return lines;
}

/**
 * 剥掉注释与字符串字面量，只留真正会被求值的代码。
 *
 * 为什么必须剥：反向依赖检查若扫原始文本，会被注释里的散文误伤 ——
 * 例如注释里出现"（不是 captureDraft 那套）"就会被判成"用了却没声明"。
 */
function stripCommentsAndStrings(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 这个模块的 `return { ... }` 块（模块最外层那个）。 */
function moduleExportBlock(body) {
  const at = body.lastIndexOf('return {');
  if (at === -1) return '';
  const end = body.indexOf('};', at);
  return end === -1 ? body.slice(at) : body.slice(at, end);
}

/**
 * 三向依赖校验。
 *
 * ⚠️ 反向检查（用了却没声明）必须排在最前面：下面 `@platform` 分支会提前 continue，
 * 放到后面就等于对几乎所有组件模块不生效。
 */
function verifyDeps(spec, body) {
  const code = stripCommentsAndStrings(body);
  const declared = new Set(['@platform', spec.name]);
  for (const dep of spec.deps) declared.add(dep);

  // ① 用了别的模块导出的名字，却没声明那个依赖 → 运行时是未定义标识符
  const foreign = new Map();
  for (const [mod, keys] of Object.entries(EXPORTS)) {
    if (declared.has(mod)) continue;
    for (const key of keys) if (!foreign.has(key)) foreign.set(key, mod);
  }
  for (const [key, mod] of foreign) {
    const pattern = new RegExp(`(?<![\\w$.])${key.replace(/\$/g, '\\$')}(?![\\w$])`);
    if (pattern.test(code)) {
      throw new Error(`${spec.name}: 用到了 ${mod} 导出的 ${key}，但 deps 里没有 ${mod}`);
    }
  }

  // ② 声明了依赖却没用
  if (spec.deps.includes('@platform')) {
    const used = Object.keys(PLATFORM).some((name) => (name === 'h' ? body.includes('h(') : body.includes(name)));
    if (!used) throw new Error(`${spec.name}: 声明了 @platform 却没用到`);
  }
  for (const dep of spec.deps) {
    if (dep === '@platform') continue;
    const alias = dep.replace(/-/g, '_');
    const used = body.includes(`${alias}.`) || EXPORTS[dep].some((key) => body.includes(key));
    if (!used) throw new Error(`${spec.name}: 声明了依赖 ${dep} 却没用到`);
  }
}

/** ③ EXPORTS 表里声明的名字，模块确实导出了（否则依赖方拿到 undefined）。 */
function verifyExports(spec, body) {
  const block = moduleExportBlock(body);
  for (const key of EXPORTS[spec.name]) {
    const declared = new RegExp(`(?<![\\w$])${key.replace(/\$/g, '\\$')}\\s*[:,]`).test(block);
    if (!declared) throw new Error(`${spec.name}: EXPORTS 表声明导出了 ${key}，但模块的 return { ... } 里没有它`);
  }
}

function build() {
  const css = readFileSync(CSS_FILE, 'utf8').trimEnd();
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const parts = [];

  parts.push(`/**
 * ${PACKAGE_ID} 浏览器半侧 bundle —— **构建产物，请勿直接编辑**。
 *
 * 源码在 src/client/ 下按模块拆分，重新生成：node scripts/build.mjs
 *
 * 模块（顺序 = 初始化顺序）：
${moduleListComment()}
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_ID)},
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
`);

  for (const spec of MODULES) {
    const body = readModule(spec, css, version);
    verifyDeps(spec, body);
    verifyExports(spec, body);
    const deps = depLines(spec);
    const indented = body
      .split('\n')
      .map((line) => (line === '' ? '' : '  ' + line))
      .join('\n');
    parts.push(`    // ===================== ${spec.name} =====================
    __factories[${JSON.stringify(spec.name)}] = function () {
${deps.map((line) => '  ' + line).join('\n')}${deps.length > 0 ? '\n' : ''}${indented}
    };
`);
  }

  parts.push(`    // ===================== 启动 =====================
    var plugin = R('plugin');
    return { apply: plugin.apply, inject: plugin.inject, name: plugin.name, __test: plugin.__test };
  },
});
`);

  return { text: parts.join('\n'), css };
}

/** 成品自检：占位符、import/export、CSS 结构、注册形态。 */
function selfCheck(text, css) {
  if (text.includes('__CSS_TEXT__')) throw new Error('CSS 占位符没有被替换');
  if (text.includes('__PACKAGE_VERSION__')) throw new Error('版本号占位符没有被替换');
  if (/^\s*import\s/m.test(text)) throw new Error('产物里出现了顶层 import');
  if (/^\s*export\s/m.test(text)) throw new Error('产物里出现了顶层 export');
  if (!text.includes('window.__ModuleLoader__.load(')) throw new Error('产物没有注册到 __ModuleLoader__');
  if (!text.includes(`id: ${JSON.stringify(PACKAGE_ID)}`)) throw new Error('产物注册的 id 与包名不一致');

  // CSS：花括号配平 + 每条规则完整在一行内（跨行规则说明拼接/截断了）
  let depth = 0;
  let underflow = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) underflow++;
    }
  }
  if (depth !== 0 || underflow !== 0) throw new Error(`CSS 花括号不配平 depth=${depth} underflow=${underflow}`);

  const cssLines = css.split('\n').filter((line) => line.trim() !== '');
  const truncated = cssLines.filter((line) => (line.includes('{') && !line.includes('}')) || (!line.includes('{') && line.includes('}')));
  if (truncated.length > 0) throw new Error('CSS 有不完整的单行规则：' + truncated[0].slice(0, 80));
  const orphans = cssLines.filter((line) => !line.includes('{') && !line.includes('}') && /^[a-z-]+\s*:/.test(line.trim()));
  if (orphans.length > 0) throw new Error('CSS 有孤儿属性行：' + orphans[0].slice(0, 80));

  // 卡片可见性：浮层容器是 pointer-events:none，卡片必须自己打开
  if (!/\.dst-card\{[^}]*pointer-events:auto/.test(css.replace(/\s+/g, ''))) {
    throw new Error('CSS 缺失 .dst-card 的 pointer-events:auto（卡片会看得见点不动）');
  }

  return { cssRules: cssLines.filter((line) => line.includes('{')).length };
}

const checkOnly = process.argv.includes('--check');
const { text, css } = build();
const { cssRules } = selfCheck(text, css);

if (checkOnly) {
  console.log(`build --check OK：${MODULES.length} 个模块，产物 ${text.length} 字符，CSS ${cssRules} 条规则`);
} else {
  writeFileSync(OUT, text, 'utf8');
  console.log(`已生成 ${OUT}`);
  console.log(`  模块 ${MODULES.length} 个｜产物 ${text.length} 字符｜CSS ${cssRules} 条规则`);
}

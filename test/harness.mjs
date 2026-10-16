/**
 * 测试台：在 Node 里把浏览器半侧的 bundle 真的跑起来。
 *
 * ## 为什么需要它
 *
 * 划词翻译最容易坏的不是"翻译对不对"（现在还没引擎），而是这些只在真实页面里
 * 才暴露的问题：
 *   · 卡片坐标算成 NaN / 跑出视口；
 *   · mouseup 时选区还没稳定，读到的还是上一段；
 *   · 点卡片时把文档选区点没了，selectionchange 反手把卡片关掉；
 *   · 会话区划词也弹卡（作用域判定失效）。
 *
 * 它们全都发生在**事件时序 + 几何算术**里，而这两块都不需要真浏览器：
 * 桩掉 React（真实的 hook 语义）、document/window（真实的事件分发与 timer）、
 * 一个可控的 Selection，就能把整条链路驱动一遍。
 *
 * ## 桩的保真度要求
 *
 * 三个地方必须像真的，否则测试是假阳性：
 *   1. `h` 绑到 `createElement(type, props, ...children)` —— 子元素不能丢；
 *   2. `useState` 的 setter 要接受**函数式更新**（过期结果比对依赖它）；
 *   3. 宿主节点的 `ref` 要在"commit"后挂上（组件读 ref.current 量尺寸）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUNDLE = join(HERE, '..', 'lib', 'client.js');
export const SOURCE = () => readFileSync(BUNDLE, 'utf8');

// ----------------------------------------------------------------- 断言工具

let failures = 0;
let checks = 0;
export function check(label, ok, detail) {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ' + String(detail)}`);
  if (!ok) failures++;
}
export function summary(name) {
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}：${name}（共 ${checks} 项）`);
  if (failures > 0) process.exitCode = 1;
}

// ----------------------------------------------------------------- 元素树

/** 极简元素：h(type, props, ...children) → { type, props, children } */
export function makeElement(type, props, ...children) {
  const flat = [];
  const push = (value) => {
    if (value === null || value === undefined || value === false || value === true) return;
    if (Array.isArray(value)) value.forEach(push);
    else flat.push(value);
  };
  push(children);
  return { type, props: props ?? {}, children: flat };
}

// ----------------------------------------------------------------- React 桩

const hookStores = new Map();
const componentKeys = new Map();
const pendingEffects = [];
let hookCursor = 0;
let currentComponent = null;
let keySeq = 0;

function hooksFor(key) {
  if (!hookStores.has(key)) hookStores.set(key, { slots: [] });
  return hookStores.get(key);
}

function keyFor(type) {
  if (!componentKeys.has(type)) componentKeys.set(type, 'c' + keySeq++);
  return componentKeys.get(type);
}

function queueEffect(effect) {
  const store = hooksFor(currentComponent);
  const index = hookCursor++;
  const key = 'effect' + index;
  /**
   * ⚠️ 槽位语义（与真实 React 的差异，写清楚免得后人误判）：
   *
   * 桩**只在该 hook 索引第一次出现时**排队执行，等价于真实 React 里
   * `useEffect(fn, [])`（挂载期一次）。本插件的 effect 正好都是空 deps：
   *   · 浮层挂监听器 —— 空 deps，挂载一次；
   *   · 卡片量高度 —— 真实 React 里每次渲染都跑，这里只在挂载那一轮跑。
   * 后者不影响断言：首轮量到的高度会被写回 state，下一轮渲染就用上了。
   *
   * 反过来，如果这里**每次都排队**，同一份 effect 会被执行多次 ——
   * 浮层会挂出第二个监听器，测试里表现为"一次划词弹两次"，是纯粹的桩缺陷。
   */
  if (key in store.slots) return;
  store.slots[key] = undefined;
  pendingEffects.push({ store, key, effect });
}

export const reactStub = {
  createElement: makeElement,
  useState(initial) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      store.slots[index],
      (next) => {
        store.slots[index] = typeof next === 'function' ? next(store.slots[index]) : next;
      },
    ];
  },
  useRef(initial) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = { current: initial };
    return store.slots[index];
  },
  useMemo(factory) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = factory();
    return store.slots[index];
  },
  useCallback(fn) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = fn;
    return store.slots[index];
  },
  useEffect: queueEffect,
  useLayoutEffect: queueEffect,
};

// ----------------------------------------------------------------- DOM 桩

/** type → [{ handler, capture, target }] */
const listeners = new Map();
function addListener(type, handler, capture) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push({ handler, capture: capture === true, target: this });
}
function removeListener(type, handler) {
  const rows = listeners.get(type) ?? [];
  const at = rows.findIndex((row) => row.handler === handler);
  if (at >= 0) rows.splice(at, 1);
}
export function listenerCount(type) {
  return (listeners.get(type) ?? []).length;
}

/** 某一类事件各监听器的 capture 标记（用来断言「必须用捕获阶段」）。 */
export function captureFlags(type) {
  return (listeners.get(type) ?? []).map((row) => row.capture === true);
}
/** 触发某一类事件（document 与 window 上注册的都会收到，模拟真实冒泡到两者）。 */
export function fire(type, event) {
  const rows = [...(listeners.get(type) ?? [])];
  for (const row of rows) row.handler(event);
  return rows.length;
}
export function resetListeners() {
  listeners.clear();
}

/** 共享的"宿主节点"：所有对象 ref 都挂到它上面，测试可改写它的行为。 */
export const cardNode = {
  getBoundingClientRect: () => ({ width: 340, height: 180, left: 0, top: 0, right: 340, bottom: 180 }),
  contains: () => false,
  closest: () => null,
  addEventListener() {},
  removeEventListener() {},
};
export function resetCardNode() {
  cardNode.getBoundingClientRect = () => ({ width: 340, height: 180, left: 0, top: 0, right: 340, bottom: 180 });
  cardNode.contains = () => false;
}

/** 被 createElement 造出来的节点（测试可以断言"注入了哪些标签"）。 */
export const created = [];

export const fakeDocument = {
  head: { appendChild() {} },
  createElement: (tag) => {
    const node = { tag, dataset: {}, style: {}, textContent: '', parentNode: null };
    created.push(node);
    return node;
  },
  querySelector: () => null,
  // guest 桥按选择器找侧栏里的 <webview>；其它选择器一律返回空集
  querySelectorAll: (selector) => (selector === 'webview[data-sidebar-browser-frame="webview"]' ? [...webviews] : []),
  visibilityState: 'visible',
  addEventListener: addListener,
  removeEventListener: removeListener,
};

/** 待跑的 timer 队列：测试自己决定"下一个 tick"什么时候到。 */
const timers = new Map();
let timerSeq = 0;
export function flushTimers() {
  const pending = [...timers.values()];
  timers.clear();
  for (const fn of pending) fn();
  return pending.length;
}
export function pendingTimers() {
  return timers.size;
}

export const fakeWindow = {
  innerWidth: 1280,
  innerHeight: 860,
  addEventListener: addListener,
  removeEventListener: removeListener,
  setTimeout: (fn) => {
    const id = ++timerSeq;
    timers.set(id, fn);
    return id;
  },
  clearTimeout: (id) => {
    timers.delete(id);
  },
  getSelection: () => currentSelection,
  setInterval: (fn) => {
    const id = ++intervalSeq;
    intervals.set(id, fn);
    return id;
  },
  clearInterval: (id) => {
    intervals.delete(id);
  },
  // 页面侧的模块系统就长这样：脚本只注册 factory，物化时机由外壳决定。
  __ModuleLoader__: {
    load(registration) {
      capturedRegistration = registration;
    },
  },
};

/** 侧栏里的 <webview> 元素（guest 桥按选择器找它们）。 */
export const webviews = [];
export function resetWebviews() {
  webviews.length = 0;
}

const intervals = new Map();
let intervalSeq = 0;
/** 跑一轮所有注册的 interval 回调（模拟"过了 400ms"）。 */
export function flushIntervals() {
  const callbacks = [...intervals.values()];
  for (const fn of callbacks) fn();
  return callbacks.length;
}
export function intervalCount() {
  return intervals.size;
}

let capturedRegistration = null;

let currentSelection = null;
export function setSelection(selection) {
  currentSelection = selection;
}

export const clipboard = { text: null, fail: false };

/**
 * 宿主翻译路由的桩。
 *
 * 客户端 `requestTranslation()` 走的是相对路径 `fetch()`，在 Node 里既解析不了
 * 也连不上 —— 所以这里把 fetch 换成可控的桩。它必须能造出**桌面版真实会出现的
 * 三种响应**，否则"运输方式回退"这条逻辑就没法测：
 *
 *   'done'          正常 JSON（POST/GET 都认）
 *   'bad-json'      502 网关页（非 JSON）
 *   'method-blocked' POST 被拦（405 无 body），但 GET 与 /health 正常
 *                    —— 对应桌面 SPA 兜底对非 GET/HEAD 的回答
 *   'route-missing' 全部 405 无 body（宿主路由根本没注册）
 *   'reject'        连不上
 */
export const http = {
  /** 记录每次请求，供断言 URL / method / body。 */
  calls: [],
  mode: 'done',
  status: 200,
  // 默认按"微软翻译出的结果"给：宿主返回的 engine 现在是 { id, label, model? }
  body: { state: 'done', text: '译文', target: 'zh-CN', engine: { id: 'microsoft', label: '微软翻译' }, elapsedMs: 812 },
  healthStatus: 200,
  healthBody: { ok: true, hasLlm: true },
  /**
   * 手动模式：请求不立刻返回，而是挂进 `pending`，由用例决定谁先回来。
   *
   * 竞态类问题（晚到的旧结果覆盖新结果）只有这样才测得出来 —— 自动返回的桩
   * 永远是"先发先回"，根本构造不出乱序。
   */
  manual: false,
  pending: [],
  /** 诊断上报单独记：它是管道，不该混进 http.calls 影响被测断言。 */
  diagCalls: [],
};

export function resetHttp() {
  http.calls.length = 0;
  http.mode = 'done';
  http.status = 200;
  http.body = { state: 'done', text: '译文', target: 'zh-CN', engine: { id: 'microsoft', label: '微软翻译' }, elapsedMs: 812 };
  http.healthStatus = 200;
  http.healthBody = { ok: true, hasLlm: true };
  http.manual = false;
  http.pending.length = 0;
  http.diagCalls.length = 0;
}

const noJson = () => Promise.reject(new Error('Unexpected token < in JSON'));
const respond = (url, init) => {
  const target = String(url);
  // 诊断上报单独收：它不该出现在 http.calls 里（否则每条断言都要跳过它一次）
  if (target.indexOf('/api/diag') !== -1) {
    let payload = null;
    try {
      payload = JSON.parse(String(init === undefined ? '' : init.body));
    } catch (error) {
      payload = null;
    }
    http.diagCalls.push(payload);
    if (http.mode === 'reject') return Promise.reject(new Error('connect ECONNREFUSED'));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  }
  http.calls.push({ url: target, init });
  if (http.mode === 'reject') return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:19387'));
  const isHealth = target.indexOf('/health') !== -1;
  const method = init === undefined || init.method === undefined ? 'GET' : String(init.method);
  // 路由整体不存在：连健康检查都是 405（宿主半侧没加载）
  if (http.mode === 'route-missing') return Promise.resolve({ ok: false, status: 405, json: noJson });
  // 只有非 GET 被拦：健康检查（GET）仍然正常 —— 桌面 SPA 兜底正是这个行为
  if (http.mode === 'method-blocked' && method !== 'GET') return Promise.resolve({ ok: false, status: 405, json: noJson });
  if (isHealth) {
    return Promise.resolve({
      ok: http.healthStatus === 200,
      status: http.healthStatus,
      json: http.healthBody === null ? noJson : () => Promise.resolve(http.healthBody),
    });
  }
  if (http.mode === 'bad-json') return Promise.resolve({ ok: false, status: http.status, json: noJson });
  if (http.manual) {
    // 挂住这次请求：用例通过 pending[i].done(body) 决定它什么时候、以什么内容返回。
    // 健康检查不挂（它是"路由在不在"的探测，必须立刻有结论）。
    return new Promise((resolve) => {
      let engine;
      try {
        engine = JSON.parse(String(init === undefined ? '' : init.body)).engine;
      } catch (error) {
        engine = undefined;
      }
      http.pending.push({
        url: target,
        init: init,
        engine: engine,
        done: (body) => resolve({ ok: true, status: 200, json: () => Promise.resolve(body === undefined ? http.body : body) }),
      });
    });
  }
  return Promise.resolve({ ok: http.status >= 200 && http.status < 300, status: http.status, json: () => Promise.resolve(http.body) });
};

Object.defineProperty(globalThis, 'fetch', {
  value: (url, init) => respond(url, init),
  configurable: true,
  writable: true,
});

/**
 * ⚠️ 必须用 defineProperty：Node 21+ 已经在 globalThis 上放了只读的 `navigator`
 * 访问器，直接赋值在严格模式（ESM）下会抛 TypeError。
 */
Object.defineProperty(globalThis, 'navigator', {
  value: {
    clipboard: {
      writeText(text) {
        if (clipboard.fail) return Promise.reject(new Error('denied'));
        clipboard.text = text;
        return Promise.resolve();
      },
    },
  },
  configurable: true,
  writable: true,
});

/**
 * localStorage 桩：客户端用它记住"上次选的引擎"。
 * Node 默认没有这个全局（也没有 window.localStorage），所以必须显式给一个，
 * 否则引擎偏好那几条断言测的其实是"存不进去时的回落"，是假阳性。
 */
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
    removeItem: (key) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    get length() {
      return storage.size;
    },
  },
  configurable: true,
  writable: true,
});
export function resetStorage() {
  storage.clear();
}

// ----------------------------------------------------------------- 载入 bundle

/**
 * 求值 bundle，返回 { registration, plugin, api, source }。
 * 全局 window/document/navigator 会被换成桩（bundle 里读的是全局）。
 */
export function loadBundle() {
  const source = SOURCE();
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  const platformRequire = (name) => {
    if (name === 'react') return reactStub;
    throw new Error('未知模块请求：' + name);
  };
  capturedRegistration = null;
  new Function('window', 'require', 'console', source)(fakeWindow, platformRequire, console);
  const registration = capturedRegistration;
  if (registration === null || registration === undefined) throw new Error('bundle 没有调用 __ModuleLoader__.load');
  const plugin = registration.factory(platformRequire);
  return { registration, plugin, api: plugin.__test, source };
}

/** 记录槽位注册的假 ctx。 */
export function makeCtx() {
  const registrations = [];
  return {
    registrations,
    ctx: {
      effect(fn) {
        const dispose = fn();
        registrations.push({ kind: 'effect', dispose });
        return () => {};
      },
      slots: {
        inject(key, callback) {
          const iterable = callback();
          if (iterable !== undefined && typeof iterable[Symbol.iterator] === 'function') {
            for (const _ of iterable) {
              /* 消费 disposer */
            }
          }
          return () => {};
        },
        register(options, component) {
          registrations.push({ kind: 'register', options, component });
          return () => {};
        },
      },
    },
  };
}

// ----------------------------------------------------------------- 展开与渲染

export function commitRefs(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(commitRefs);
  if (typeof node.type === 'string') {
    const ref = node.props?.ref;
    if (ref !== null && ref !== undefined && typeof ref === 'object' && 'current' in ref) ref.current = cardNode;
  }
  node.children = (node.children ?? []).map(commitRefs);
  return node;
}

export function expand(node, depth) {
  if (node === null || node === undefined) return node;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, depth));
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    if (depth > 40) throw new Error('展开层数过深，可能有循环组件');
    const previous = currentComponent;
    const previousCursor = hookCursor;
    currentComponent = keyFor(node.type);
    hookCursor = 0;
    let rendered;
    try {
      rendered = node.type(node.props);
    } finally {
      currentComponent = previous;
      hookCursor = previousCursor;
    }
    return expand(rendered, depth + 1);
  }
  return commitRefs({
    type: node.type,
    props: node.props,
    children: (node.children ?? []).map((child) => expand(child, depth)).filter((child) => child !== null),
  });
}

function flushEffects() {
  const queued = pendingEffects.splice(0, pendingEffects.length);
  for (const item of queued) item.store.slots[item.key] = item.effect();
  return queued.length;
}

/**
 * 渲染一次（含 effect 与"效应改了 state 后再渲染"的收尾）。
 *
 * 根组件也必须走 expand：直接 `component(props)` 会让 hook 挂到上一个组件的 key 上，
 * 于是清槽位清不掉、用例之间互相污染。
 */
export function render(component, props) {
  const root = () => ({ type: component, props: props ?? {}, children: [] });
  let tree = expand(commitRefs(root()), 0);
  for (let pass = 0; pass < 3; pass++) {
    if (flushEffects() === 0) break;
    tree = expand(commitRefs(root()), 0);
  }
  return tree;
}

/** 清掉某个组件的 hook 槽位，让挂载期 effect 重新排一次（模拟全新挂载）。 */
export function resetMount(component) {
  const key = componentKeys.get(component);
  if (key !== undefined) hookStores.delete(key);
}

// ----------------------------------------------------------------- 遍历工具

export function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return (node.children ?? []).map(textOf).join(' ');
}

export function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

export function byClass(node, className) {
  return findNode(
    node,
    (row) => typeof row.props?.className === 'string' && row.props.className.split(' ').includes(className),
  );
}

export function collectNumbers(node, out = [], path = 'root') {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectNumbers(child, out, `${path}[${index}]`));
    return out;
  }
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (typeof value === 'number') out.push({ path: `${path}.${node.type}.${key}`, value });
  }
  (node.children ?? []).forEach((child, index) => collectNumbers(child, out, `${path}>${index}`));
  return out;
}

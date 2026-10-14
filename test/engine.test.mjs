/**
 * 宿主侧引擎与路由的单测。
 *
 * 这一层最容易出错的不是算法，而是**与模型服务的契约**：
 *   · 请求参数有没有按 GenerateOptions 传（provider/model/messages/system/temperature/maxTokens）；
 *   · 终止分片怎么判（`finish.kind` 是 stop / error / aborted 三选一）；
 *   · 失败码有没有原样带出来（用户看到的一句话之外，程序还要能按 code 分流）；
 *   · 路由的 HTTP 语义（200/400/404/502）与缓存行为。
 *
 * 全部用一个假的 `llm.stream` 异步生成器驱动，不联网、不花 token。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouteHandler, describeRuntime, apply, modelFromSessionEvents, resolveConfig, ROUTE_PREFIX, VERSION } from '../lib/index.js';
import {
  LANGUAGE_NAMES,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  buildMessages,
  cacheKey,
  createCache,
  estimateMaxTokens,
  failureMessage,
  languageName,
  normalizeSource,
  normalizeTarget,
  resolveSelection,
  runTranslation,
  sourceName,
  stripCodeFence,
} from '../lib/engine.js';

let failures = 0;
let checks = 0;
function check(label, ok, detail) {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ' + String(detail)}`);
  if (!ok) failures++;
}
function summary(name) {
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}：${name}（共 ${checks} 项）`);
  if (failures > 0) process.exitCode = 1;
}

// ----------------------------------------------------------------- 假 llm

/** 造一个假的 llm 服务；`script` 是分片序列，或一个函数（收到 options 返回分片数组）。 */
function fakeLlm(script) {
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }],
    stream(options) {
      calls.push(options);
      const chunks = typeof script === 'function' ? script(options) : script;
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

const text = (value) => ({ type: 'text-delta', index: 0, text: value });
const stop = { type: 'finish', reason: { kind: 'stop' } };
const engineError = (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } });

// ----------------------------------------------------------------- 纯函数

check('语言名：已知代码有名字', languageName('en') === '英语' && languageName('zh-CN') === '简体中文');
check('语言名：只给主语言也能认（zh → 简体中文）', normalizeTarget('zh') === 'zh-CN', normalizeTarget('zh'));
check('语言名：认不出来回落默认目标', normalizeTarget('klingon') === 'zh-CN' && normalizeTarget('') === 'zh-CN' && normalizeTarget(undefined) === 'zh-CN');
check('语言表：至少覆盖常见几种', ['zh-CN', 'en', 'ja'].every((code) => LANGUAGE_NAMES[code] !== undefined), JSON.stringify(Object.keys(LANGUAGE_NAMES)));

check(
  '请求消息：只有一条 user 消息，且带上目标语言与原文',
  (() => {
    const messages = buildMessages('Hello world', 'zh-CN');
    return (
      messages.length === 1 &&
      messages[0].role === 'user' &&
      messages[0].content.length === 1 &&
      messages[0].content[0].type === 'text' &&
      messages[0].content[0].text.includes('简体中文') &&
      messages[0].content[0].text.includes('Hello world')
    );
  })(),
  JSON.stringify(buildMessages('x', 'en')),
);

check(
  '提示词：把"只输出译文/保留换行/代码原样/已是目标语言就原样返回"都写进去了',
  SYSTEM_PROMPT.includes('只输出译文') && SYSTEM_PROMPT.includes('换行') && SYSTEM_PROMPT.includes('原样返回'),
);

check('输出上限：短输入不低于下限', estimateMaxTokens('hi') >= MIN_OUTPUT_TOKENS, String(estimateMaxTokens('hi')));
check(
  '输出上限：下限足够容纳推理 token（历史上就是被思考吃光才出现"没有返回内容"）',
  MIN_OUTPUT_TOKENS >= 2048,
  String(MIN_OUTPUT_TOKENS),
);
check('输出上限：长输入不超过上限', estimateMaxTokens('x'.repeat(MAX_INPUT_CHARS)) === MAX_OUTPUT_TOKENS, String(estimateMaxTokens('x'.repeat(MAX_INPUT_CHARS))));
check('输出上限：随长度增长', estimateMaxTokens('x'.repeat(2000)) > estimateMaxTokens('x'.repeat(200)), `${estimateMaxTokens('x'.repeat(200))} → ${estimateMaxTokens('x'.repeat(2000))}`);

check(
  '模型选择：跟随默认选择',
  (() => {
    const selection = resolveSelection({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' });
    return selection.provider === 'deepseek-account' && selection.model === 'deepseek-flash';
  })(),
);
check('模型选择：不透传 reasoningEffort（翻译要快，high 是写代码用的）', resolveSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }).reasoningEffort === undefined);
check('模型选择：缺失时回落兜底路由', resolveSelection(undefined).provider === 'deepseek-account' && resolveSelection({}).model === 'deepseek-flash');

check(
  '失败码：已知码给中文解释并带上细节',
  failureMessage({ code: 'RATE_LIMIT', message: 'slow down' }).includes('限流') && failureMessage({ code: 'RATE_LIMIT', message: 'slow down' }).includes('slow down'),
  failureMessage({ code: 'RATE_LIMIT', message: 'slow down' }),
);
check('失败码：账号余额单独成条（要引导充值而不是重试）', failureMessage({ code: 'ACCOUNT_QUOTA', message: '' }).includes('余额'));
check('失败码：认不出的码原样带出来（绝不吞）', failureMessage({ code: 'WEIRD_CODE', message: '' }).includes('WEIRD_CODE'));
check('失败码：什么都没有时给一句兜底', failureMessage(undefined) === '翻译失败');

check('围栏：整段被 ``` 包住时剥掉', stripCodeFence('```\n你好\n```') === '你好', stripCodeFence('```\n你好\n```'));
check('围栏：带语言标记也剥', stripCodeFence('```text\n你好\n```') === '你好');
check('围栏：正文中间的代码块不动（避免误伤）', stripCodeFence('前\n```\ncode\n```\n后') === '前\n```\ncode\n```\n后');
check('围栏：没有围栏时原样返回（含 trim）', stripCodeFence('  你好  ') === '你好');

// ----------------------------------------------------------------- 缓存

{
  const cache = createCache(3);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  check('缓存：命中', cache.get('a') === 1);
  cache.set('d', 4);
  check('缓存：到上限丢最旧（a 被 get 过所以留下来了，b 被淘汰）', cache.get('b') === undefined && cache.get('a') === 1, `size=${cache.size}`);
  check('缓存：上限生效', cache.size === 3, String(cache.size));
  cache.clear();
  check('缓存：清空', cache.size === 0);
}
check('缓存键：目标语言不同则不同条目', cacheKey('hi', 'zh-CN') !== cacheKey('hi', 'en'));

// ----------------------------------------------------------------- runTranslation

{
  const llm = fakeLlm([{ type: 'block-start', index: 0, blockType: 'text' }, text('你好'), text('，世界'), { type: 'usage', usage: { inputTokens: 10, outputTokens: 6 } }, stop]);
  const result = await runTranslation({ text: 'Hello, world', target: 'zh-CN' }, { llm, now: (() => { let t = 1000; return () => (t += 812); })() });
  check('翻译：成功时拼接所有 text-delta', result.state === 'done' && result.text === '你好，世界', JSON.stringify(result));
  check('翻译：带上 target 与 engine', result.target === 'zh-CN' && result.engine.provider === 'deepseek-account' && result.engine.model === 'deepseek-flash');
  check('翻译：带上 usage 与耗时', result.usage.outputTokens === 6 && result.elapsedMs > 0, JSON.stringify({ usage: result.usage, elapsedMs: result.elapsedMs }));

  const request = llm.calls[0];
  check('请求：按 GenerateOptions 传 provider/model', request.provider === 'deepseek-account' && request.model === 'deepseek-flash');
  check('请求：带 system 与 messages', typeof request.system === 'string' && Array.isArray(request.messages) && request.messages.length === 1);
  check('请求：temperature=0（翻译要稳定，不要发挥）', request.temperature === 0, String(request.temperature));
  check('请求：设了 maxTokens', request.maxTokens === estimateMaxTokens('Hello, world'), String(request.maxTokens));
  check('请求：没有透传 reasoningEffort', request.reasoningEffort === undefined, String(request.reasoningEffort));
  check('请求：带取消信号（超时用）', request.signal !== undefined && typeof request.signal.aborted === 'boolean');
}

{
  const llm = fakeLlm([text('```\n译文\n```'), stop]);
  const result = await runTranslation({ text: 'x', target: 'zh-CN' }, { llm });
  check('翻译：输出里的围栏被剥掉', result.state === 'done' && result.text === '译文', JSON.stringify(result.text));
}

{
  // 适配器只给 block-end、不给 token 级 delta 时的兜底
  const llm = fakeLlm([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '整块译文' } },
    stop,
  ]);
  const result = await runTranslation({ text: 'x', target: 'zh-CN' }, { llm });
  check('翻译：只有 block-end 时也能拿到文本（BlockAssembler 的兜底）', result.state === 'done' && result.text === '整块译文', JSON.stringify(result));
}

{
  // 非文本块（例如模型擅自发起工具调用）必须被忽略，不能混进译文
  const llm = fakeLlm([
    text('正文'),
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' } },
    stop,
  ]);
  const result = await runTranslation({ text: 'x', target: 'zh-CN' }, { llm });
  check('翻译：忽略非文本块（只取译文正文）', result.state === 'done' && result.text === '正文', JSON.stringify(result.text));
}

{
  const result = await runTranslation({ text: 'x', target: 'zh-CN' }, { llm: fakeLlm([engineError('ACCOUNT_QUOTA', '余额不足')]) });
  check('翻译：finish.kind=error 时给出中文原因', result.state === 'error' && result.error.includes('余额'), JSON.stringify(result));
  check('翻译：失败码原样带出来（程序要能分流）', result.code === 'ACCOUNT_QUOTA', String(result.code));
}

{
  const result = await runTranslation({ text: 'x', target: 'zh-CN' }, { llm: fakeLlm([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '' } } }]) });
  check('翻译：finish.kind=aborted 时报告被取消', result.state === 'error' && result.code === 'ABORTED', JSON.stringify(result));
}

{
  const llm = {
    stream() {
      return (async function* () {
        yield text('半句');
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      })();
    },
  };
  const result = await runTranslation({ text: 'x', target: 'zh-CN' }, { llm });
  check('翻译：流中途抛错也收敛成 error 结果（不把异常抛给卡片）', result.state === 'error' && result.error.includes('socket hang up'), JSON.stringify(result));
  check('翻译：抛错也带 code', result.code === 'ECONNRESET', String(result.code));
}

{
  const result = await runTranslation({ text: 'x' }, { llm: undefined });
  check('翻译：宿主拿不到 llm 服务时给出可读原因', result.state === 'error' && result.code === 'NO_LLM_SERVICE', JSON.stringify(result));
}

// 空结果必须能自述原因：卡片上只写"模型没有返回内容"是没法下手的
{
  const llm = fakeLlm([{ type: 'reasoning-delta', text: '让我想想…' }, { type: 'reasoning-delta', text: '再想想…' }, { type: 'finish', reason: { kind: 'max-tokens' } }]);
  const result = await runTranslation({ text: 'x'.repeat(600), target: 'zh-CN' }, { llm });
  check('模型：思考吃光预算时报 OUTPUT_BUDGET_EXHAUSTED（可重试/缩选区）', result.state === 'error' && result.code === 'OUTPUT_BUDGET_EXHAUSTED', String(result.code));
  check('模型：错误里点明"预算花在思考上"并给出预算值', result.error.includes('思考') && /\d+ tokens/.test(result.error), result.error);
  check('模型：带上分片计数（思考 2、文本 0）', result.counts.reasoning === 2 && result.counts.text === 0, JSON.stringify(result.counts));
}
{
  const llm = fakeLlm([{ type: 'tool-call-delta', text: '{}' }, { type: 'finish', reason: { kind: 'stop' } }]);
  const result = await runTranslation({ text: 'x', target: 'zh-CN' }, { llm });
  check('模型：只回了工具调用时也自述清楚（不算成功）', result.state === 'error' && result.code === 'EMPTY_OUTPUT' && result.error.includes('工具 1'), result.error);
  check('模型：错误里带 finish 类型', result.finishKind === 'stop', String(result.finishKind));
}
{
  const result = await runTranslation({ text: '   ' }, { llm: fakeLlm([stop]) });
  check('翻译：空文本直接拒绝，不发请求', result.state === 'error' && result.code === 'EMPTY_INPUT', JSON.stringify(result));
}
{
  const llm = fakeLlm([text('ok'), stop]);
  const result = await runTranslation({ text: 'x'.repeat(MAX_INPUT_CHARS + 500) }, { llm });
  check('翻译：超长输入被截断并打标', result.state === 'done' && result.truncated === true, JSON.stringify({ state: result.state, truncated: result.truncated }));
  check('翻译：发给模型的是截断后的文本', llm.calls[0].messages[0].content[0].text.length < MAX_INPUT_CHARS + 500);
}
{
  const llm = fakeLlm([text('   '), stop]);
  const result = await runTranslation({ text: 'x' }, { llm });
  check('翻译：模型只回了空白 → 报"没有返回内容"', result.state === 'error' && result.code === 'EMPTY_OUTPUT', JSON.stringify(result));
}
{
  // 超时：流一直不产出，等 abort 信号后才给终止分片
  const llm = {
    stream(options) {
      return (async function* () {
        await new Promise((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener('abort', resolve);
        });
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '' } } };
      })();
    },
  };
  const result = await runTranslation({ text: 'x' }, { llm, timeoutMs: 20 });
  check('翻译：超时收敛成可重试的错误', result.state === 'error' && result.code === 'TIMEOUT', JSON.stringify(result));
}

// 源语言：与目标是两件事（源可以是 auto，目标不行）
{
  check(
    '源语言：auto / auto-detect / 空 / 缺失 都归一成 auto',
    normalizeSource('auto') === 'auto' && normalizeSource('auto-detect') === 'auto' && normalizeSource('') === 'auto' && normalizeSource(undefined) === 'auto',
  );
  check('源语言：具体语言被归一（zh → zh-CN、JA → ja）', normalizeSource('zh') === 'zh-CN' && normalizeSource('JA') === 'ja');
  check('源语言：认不出来的回落 auto（不是回落中文——那会把原文当译文）', normalizeSource('klingon') === 'auto', normalizeSource('klingon'));
  check('源语言：提示词里说人话（auto → 自动判断）', sourceName('auto') === '自动判断' && sourceName('ja') === '日语', sourceName('ja'));

  // 语言表扩充后的关键行为：不在表里但**看起来就是语言代码**的，不能被当成"未知"而回落
  check('目标语言：表里没有的规范代码原样保留（选了瑞典语就该翻成瑞典语）', normalizeTarget('sv') === 'sv' && normalizeTarget('th') === 'th', `${normalizeTarget('sv')}/${normalizeTarget('th')}`);
  check('目标语言：只给主语言时补成表里的具体代码（zh → zh-CN）', normalizeTarget('zh') === 'zh-CN', normalizeTarget('zh'));
  check('目标语言：真的不像代码时才回落默认', normalizeTarget('klingon') === 'zh-CN' && normalizeTarget('') === 'zh-CN', normalizeTarget('klingon'));
  check(
    '语言名：表里的说中文名，表外的直接用代码（模型认得出 sv，写"简体中文"就是错的）',
    languageName('sv') === '瑞典语' && languageName('zh-CN') === '简体中文' && languageName('xx') === 'xx',
    `${languageName('sv')} / ${languageName('xx')}`,
  );
  check('语言名表：覆盖面足够（≥70 门语言）', Object.keys(LANGUAGE_NAMES).length >= 70, String(Object.keys(LANGUAGE_NAMES).length));

  const llm = fakeLlm([text('译文'), stop]);
  await runTranslation({ text: 'x', target: 'zh-CN', source: 'ja' }, { llm });
  const prompt = llm.calls[0].messages[0].content[0].text;
  check('模型：请求里带上了源语言（用户手选日语时不该再让它猜）', prompt.includes('源语言：日语'), prompt.split('\n')[0]);
  check('模型：目标语言同一行里也有', prompt.includes('目标语言：简体中文'), prompt.split('\n')[1]);
  check(
    '缓存键：源语言不同 → 键不同（"自动检测"与"指定日语"可能得到不同译文）',
    cacheKey('x', 'zh-CN', 'microsoft', 'auto') !== cacheKey('x', 'zh-CN', 'microsoft', 'ja') && cacheKey('x', 'zh-CN', 'microsoft', undefined) === cacheKey('x', 'zh-CN', 'microsoft', 'auto'),
  );
}

// ----------------------------------------------------------------- 路由

function makeHandler(overrides) {
  const opts = overrides ?? {};
  const llm = opts.llm === undefined ? fakeLlm([text('译文'), stop]) : opts.llm;
  const handler = createRouteHandler({
    cache: opts.cache,
    tokenCache: opts.tokenCache,
    sessionTtlMs: opts.sessionTtlMs,
    describe: () =>
      Object.assign(
        { llm: llm, selection: { provider: 'deepseek-account', model: 'deepseek-flash' }, providers: ['deepseek-account'] },
        opts.sessionController === undefined ? {} : { sessionController: opts.sessionController },
      ),
    version: '9.9.9',
    // 默认只开模型引擎：这一组用例验证的是模型路径与路由语义，不该顺手打真实网络。
    // 引擎顺序与出站 fetch 由需要它们的用例显式注入。
    config: opts.config === undefined ? resolveConfig({ engines: ['llm'] }) : opts.config,
    fetch: opts.fetch === undefined ? () => Promise.reject(new Error('这个用例不该发出站请求')) : opts.fetch,
  });
  return { handler, llm };
}

/** 造一个假 sessionController：按 sessionId 返回事件日志（或抛错）。 */
function fakeSessions(table) {
  const calls = [];
  return {
    calls,
    async inspect(sessionId) {
      calls.push(sessionId);
      const value = table[sessionId];
      if (value === undefined) throw Object.assign(new Error('session/not-found'), { code: 'session/not-found' });
      return { meta: { id: sessionId }, inheritedEventCount: 0, events: value };
    },
  };
}

/** 一条 request/context 事件（会话请求日志里记录当前模型的地方）。 */
const ctxEvent = (provider, model, seq) => ({ type: 'request/context', seq: seq ?? 1, time: 0, data: { provider: provider, model: model } });
/** 一条 request/header 事件（另一种带模型的记录）。 */
const headerEvent = (provider, model) => ({ type: 'request/header', seq: 1, time: 0, data: { header: { config: { provider: provider, model: model } }, reason: 'initial' } });

// 会话日志 → 当前模型（A 方案的地基）
{
  check('会话模型：取最后一条 request/context（会话中途换过模型时以最后一条为准）', (() => {
    const found = modelFromSessionEvents([ctxEvent('p', 'old', 1), { type: 'user/message', seq: 2, data: {} }, ctxEvent('p', 'new', 3)]);
    return found !== null && found.model === 'new';
  })());
  check('会话模型：没有 context 时退回 request/header', (() => {
    const found = modelFromSessionEvents([{ type: 'turn/start', seq: 1, data: {} }, headerEvent('prov', 'model-x')]);
    return found !== null && found.provider === 'prov' && found.model === 'model-x';
  })());
  check('会话模型：字段缺失/类型不对时不硬猜', (() => {
    return (
      modelFromSessionEvents([{ type: 'request/context', seq: 1, data: { provider: 'p' } }]) === null &&
      modelFromSessionEvents([{ type: 'request/header', seq: 1, data: {} }]) === null &&
      modelFromSessionEvents([{ type: 'request/context', seq: 1, data: { provider: '', model: 'm' } }]) === null
    );
  })());
  check('会话模型：空日志/非数组返回 null（新会话还没有任何请求）', modelFromSessionEvents([]) === null && modelFromSessionEvents(undefined) === null);
}

// 跟随当前对话：会话日志里的模型优先于全局默认
{
  const sessions = fakeSessions({ 'sess-1': [ctxEvent('deepseek-account', 'deepseek-flash', 1), ctxEvent('my-provider', 'my-model', 2)] });
  const { handler, llm } = makeHandler({ sessionController: sessions });
  const result = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', engine: 'llm', sessionId: 'sess-1' });
  check('跟随会话：翻译用的是会话日志里的模型', result.status === 200 && llm.calls[0].provider === 'my-provider' && llm.calls[0].model === 'my-model', JSON.stringify({ provider: llm.calls[0]?.provider, model: llm.calls[0]?.model }));
  check('跟随会话：读过一次会话日志', sessions.calls.join(',') === 'sess-1', sessions.calls.join(','));

  const health = await handler('GET', ROUTE_PREFIX + '/health');
  check(
    '跟随会话：/health 自证模型来自会话',
    health.obj.sessionFollow.last.source === 'session' && health.obj.sessionFollow.last.model === 'my-model',
    JSON.stringify(health.obj.sessionFollow),
  );
}

{
  // 没带 sessionId（旧客户端 / 拿不到会话）→ 全局默认，功能不受影响
  const sessions = fakeSessions({ 'sess-1': [ctxEvent('my-provider', 'my-model')] });
  const { handler, llm } = makeHandler({ sessionController: sessions });
  const result = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', engine: 'llm' });
  check('跟随会话：没带 sessionId 时用全局默认', result.status === 200 && llm.calls[0].model === 'deepseek-flash' && sessions.calls.length === 0, JSON.stringify({ model: llm.calls[0]?.model, inspects: sessions.calls.length }));
}

{
  // 会话读失败（不存在/权限）→ 回落默认，并且说明原因
  const sessions = fakeSessions({});
  const { handler, llm } = makeHandler({ sessionController: sessions });
  const result = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', engine: 'llm', sessionId: 'sess-missing' });
  check('跟随会话：读会话失败时回落全局默认（不能因此翻不了）', result.status === 200 && llm.calls[0].model === 'deepseek-flash', JSON.stringify(llm.calls[0]?.model));
  const health = await handler('GET', ROUTE_PREFIX + '/health');
  check('跟随会话：/health 说明回落原因', health.obj.sessionFollow.last.source === 'default' && health.obj.sessionFollow.last.reason.includes('读取会话失败'), JSON.stringify(health.obj.sessionFollow.last));
}

{
  // 新会话（日志里还没有请求记录）→ 默认；宿主没有 sessionController → 默认
  const empty = fakeSessions({ 'sess-new': [] });
  const { handler, llm } = makeHandler({ sessionController: empty });
  await handler('POST', ROUTE_PREFIX + '/translate', { text: 'A', engine: 'llm', sessionId: 'sess-new' });
  check('跟随会话：新会话还没有请求记录时用默认', llm.calls[0].model === 'deepseek-flash', String(llm.calls[0]?.model));

  const bare = makeHandler();
  await bare.handler('POST', ROUTE_PREFIX + '/translate', { text: 'B', engine: 'llm', sessionId: 'sess-x' });
  check('跟随会话：宿主没有 sessionController 时用默认（不报错）', bare.llm.calls[0].model === 'deepseek-flash', String(bare.llm.calls[0]?.model));
}

{
  // 缓存：连续划词不该每次都把会话日志读一遍
  const sessions = fakeSessions({ 'sess-1': [ctxEvent('my-provider', 'my-model')] });
  const { handler } = makeHandler({ sessionController: sessions });
  await handler('POST', ROUTE_PREFIX + '/translate', { text: 'first', engine: 'llm', sessionId: 'sess-1' });
  await handler('POST', ROUTE_PREFIX + '/translate', { text: 'second', engine: 'llm', sessionId: 'sess-1' });
  check('跟随会话：同一会话的模型被缓存（两次翻译只读一次日志）', sessions.calls.length === 1, JSON.stringify(sessions.calls));

  // 缓存可关（ttl=0）：每次都重新读，用来验证"用户换了模型能立刻生效"
  const fresh = fakeSessions({ 'sess-2': [ctxEvent('p', 'm1')] });
  const zero = makeHandler({ sessionController: fresh, sessionTtlMs: 0 });
  await zero.handler('POST', ROUTE_PREFIX + '/translate', { text: 'a', engine: 'llm', sessionId: 'sess-2' });
  await zero.handler('POST', ROUTE_PREFIX + '/translate', { text: 'b', engine: 'llm', sessionId: 'sess-2' });
  check('跟随会话：ttl=0 时每次都重新读（缓存是可配置的）', fresh.calls.length === 2, JSON.stringify(fresh.calls));
}

{
  const { handler } = makeHandler();
  const health = await handler('GET', ROUTE_PREFIX + '/health');
  check('路由：/health 报告版本与可用性', health.status === 200 && health.obj.version === '9.9.9' && health.obj.hasLlm === true, JSON.stringify(health.obj));
  check('路由：/health 报告提供方与当前模型选择', health.obj.providers[0] === 'deepseek-account' && health.obj.selection.model === 'deepseek-flash');
  check(
    '路由：/health 报告引擎目录与自动模式顺序',
    Array.isArray(health.obj.engines) &&
      health.obj.engines.map((row) => row.id).join(',') === 'microsoft,google,llm' &&
      health.obj.order.join(',') === 'llm',
    JSON.stringify({ engines: health.obj.engines?.map((row) => row.id), order: health.obj.order }),
  );
  check(
    '路由：/health 说明每个引擎的模式（免费端点 / 官方 API）',
    health.obj.engines.find((row) => row.id === 'microsoft')?.mode === 'free' &&
      health.obj.engines.find((row) => row.id === 'google')?.mode === 'free',
    JSON.stringify(health.obj.engines),
  );
  check('路由：/health 报告两档超时', health.obj.timeouts.free > 0 && health.obj.timeouts.llm > 0, JSON.stringify(health.obj.timeouts));
}

{
  const { handler, llm } = makeHandler();
  const first = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', target: 'zh-CN', source: 'ja' });
  check('路由：接受 source 并正常返回', first.status === 200 && first.obj.state === 'done', JSON.stringify(first.obj.state));
  const second = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', target: 'zh-CN', source: 'ja' });
  check('路由：同源语言命中缓存', second.obj.cached === true && llm.calls.length === 1, `calls=${llm.calls.length}`);
  const other = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', target: 'zh-CN', source: 'auto' });
  check('路由：换源语言不走缓存（否则用户手选后看不到重译）', other.obj.cached === undefined && llm.calls.length === 2, `calls=${llm.calls.length}`);
  const viaGet = await handler('GET', ROUTE_PREFIX + '/translate?text=Hello&target=zh-CN&source=ko');
  check('路由：GET 也能带 source', viaGet.status === 200 && viaGet.obj.state === 'done', JSON.stringify(viaGet.obj.state));
}

{
  const { handler, llm } = makeHandler();
  const first = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', target: 'zh-CN' });
  check('路由：POST /translate 成功返回 200 + done', first.status === 200 && first.obj.state === 'done' && first.obj.text === '译文', JSON.stringify(first.obj));
  const second = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', target: 'zh-CN' });
  check('路由：同一段文本命中缓存（不再调模型）', second.obj.cached === true && llm.calls.length === 1, `calls=${llm.calls.length}`);
  const other = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', target: 'en' });
  check('路由：换目标语言不走缓存', other.obj.cached === undefined && llm.calls.length === 2, `calls=${llm.calls.length}`);
}

{
  const { handler } = makeHandler({ llm: fakeLlm([engineError('RATE_LIMIT', '')]) });
  const failed = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello' });
  check('路由：引擎失败返回 502（不是 200 里塞个 error）', failed.status === 502 && failed.obj.state === 'error', `${failed.status} ${JSON.stringify(failed.obj)}`);
  check('路由：失败结果不进缓存', (await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello' })).obj.cached === undefined);
}

{
  const { handler } = makeHandler();
  check('路由：空 body 文本 → 400', (await handler('POST', ROUTE_PREFIX + '/translate', { text: '  ' })).status === 400);
  check('路由：缺 body → 400', (await handler('POST', ROUTE_PREFIX + '/translate', undefined)).status === 400);
  check('路由：未知路径 → 404', (await handler('GET', ROUTE_PREFIX + '/nope')).status === 404);
  check('路由：未知方法 → 404', (await handler('DELETE', ROUTE_PREFIX + '/translate')).status === 404);
  check(
    '路由：目标语言非法时回落默认（不报错）',
    (await handler('POST', ROUTE_PREFIX + '/translate', { text: 'x', target: 'klingon' })).obj.target === 'zh-CN',
  );
}

// GET 运输方式：桌面版的页面请求经 Electron 协议处理器转发，且未匹配具名路由的
// 非 GET/HEAD 会被 SPA 兜底回答 405，所以路由必须也认 GET。
{
  const { handler, llm } = makeHandler();
  const encoded = encodeURIComponent('Hello from GET');
  const got = await handler('GET', ROUTE_PREFIX + '/translate?text=' + encoded + '&target=en');
  check('GET：查询串里的文本能被翻译', got.status === 200 && got.obj.state === 'done' && got.obj.target === 'en', JSON.stringify(got.obj).slice(0, 160));
  check('GET：与 POST 走同一套引擎逻辑（模型被调用了一次）', llm.calls.length === 1 && llm.calls[0].provider === 'deepseek-account');
  check(
    'GET：目标语言取自查询串（没给就回落默认）',
    (await handler('GET', ROUTE_PREFIX + '/translate?text=hi')).obj.target === 'zh-CN',
  );
  check('GET：缺 text → 400', (await handler('GET', ROUTE_PREFIX + '/translate')).status === 400);
  check('GET：空 text → 400', (await handler('GET', ROUTE_PREFIX + '/translate?text=%20%20')).status === 400);
  const tooLong = await handler('GET', ROUTE_PREFIX + '/translate?text=' + 'x'.repeat(2000));
  check('GET：超长文本 → 413 并说明原因（而不是让 URL 撑爆请求头）', tooLong.status === 413 && tooLong.obj.code === 'TEXT_TOO_LONG_FOR_GET', JSON.stringify(tooLong.obj));
  check('GET：POST 不受这个长度限制（长选区仍可翻译）', (await handler('POST', ROUTE_PREFIX + '/translate', { text: 'x'.repeat(2000) })).status === 200);
}

// ----------------------------------------------------------------- describeRuntime

{
  const llm = fakeLlm([stop]);
  const runtime = describeRuntime({
    get: (key) => (key === 'llm' ? llm : key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }) } : undefined),
  });
  check('运行时：读到 llm 与默认模型选择', runtime.llm === llm && runtime.selection.provider === 'p' && runtime.selection.model === 'm');
  check('运行时：提供方清单取自 llm.listProviders', runtime.providers.length === 1 && runtime.providers[0] === 'deepseek-account');
}
{
  const runtime = describeRuntime({
    get: (key) => {
      if (key === 'llm') return { listProviders: () => { throw new Error('boom'); } };
      if (key === 'agentDefaultModel') return { currentSelection: () => { throw new Error('boom'); } };
      return undefined;
    },
  });
  check('运行时：服务抛错时不连带崩（清单空、选择缺省）', Array.isArray(runtime.providers) && runtime.providers.length === 0 && runtime.selection === undefined);
}
check('运行时：没有任何服务时也能描述（llm=undefined）', describeRuntime({ get: () => undefined }).llm === undefined);
check('运行时：ctx 连 get 都没有时不抛', describeRuntime({}).llm === undefined);

// ----------------------------------------------------------------- apply + 假 HTTP

/** 假请求：method/url + 可迭代 body。 */
function fakeRequest(method, url, body) {
  return {
    method,
    url,
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
    },
  };
}
/** 假响应：记录 status / headers / body。 */
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    payload: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(payload) {
      this.payload = payload;
    },
  };
}

{
  const registered = [];
  const logs = [];
  const llm = fakeLlm([text('路由译文'), stop]);
  const ctx = {
    get: (key) => (key === 'llm' ? llm : key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } : undefined),
    effect(fn) {
      const dispose = fn();
      registered.push({ kind: 'effect', dispose });
      return () => {};
    },
    webServer: {
      register(route) {
        registered.push({ kind: 'route', route });
        return () => {};
      },
    },
    logger: () => ({ info: (line) => logs.push(line) }),
  };
  // ⚠️ 这里必须把引擎限制成模型那一路：默认顺序含两个免费端点，
  // 走默认配置就会真的发出站请求（慢、且依赖网络），测试不该那样。
  apply(ctx, { engines: ['llm'] });

  const route = registered.find((row) => row.kind === 'route');
  check('apply：注册了 prefix 路由', route !== undefined && route.route.kind === 'prefix' && route.route.path === ROUTE_PREFIX, JSON.stringify(route?.route?.path));
  check('apply：路由挂在 ctx.effect 下（卸载时可回收）', registered.some((row) => row.kind === 'effect'));
  check('apply：启动日志说明了 llm 与默认模型', logs.some((line) => line.includes('llm=可用') && line.includes('deepseek-account/deepseek-flash')), logs.join(' | '));
  check('apply：启动日志说明了引擎顺序', logs.some((line) => line.includes('引擎：') && line.includes('模型')), logs.join(' | '));
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  check('apply：版本取自 package.json（不是手写的）', VERSION === manifest.version, `${VERSION} vs ${manifest.version}`);
  check(
    '配置：默认顺序是 微软 → Google → 模型（实测这台机器上微软可达、Google 不可达）',
    resolveConfig(undefined).engines.join(',') === 'microsoft,google,llm',
    resolveConfig(undefined).engines.join(','),
  );

  const health = fakeResponse();
  await route.route.handler(fakeRequest('GET', ROUTE_PREFIX + '/health'), health);
  check('假 HTTP：/health 走通了真实 handler', health.status === 200 && JSON.parse(health.payload).ok === true, health.payload);

  const translated = fakeResponse();
  await route.route.handler(fakeRequest('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', target: 'zh-CN' }), translated);
  const body = JSON.parse(translated.payload);
  check('假 HTTP：POST 读得到 body 并返回译文', translated.status === 200 && body.state === 'done' && body.text === '路由译文', translated.payload);
  check('假 HTTP：响应头是 JSON 且不缓存', translated.headers['content-type'].includes('application/json') && translated.headers['cache-control'] === 'no-store');
}

{
  // 宿主侧拿不到 llm：路由必须仍然可用，并以 502 + 可读原因作答
  const registered = [];
  const ctx = {
    get: () => undefined,
    effect(fn) {
      registered.push(fn());
      return () => {};
    },
    webServer: {
      register(route) {
        registered.push(route);
        return () => {};
      },
    },
    logger: () => ({ info: () => {} }),
  };
  // 同样只开模型引擎：否则这条用例会去真的打两个免费端点（慢且依赖网络）
  apply(ctx, { engines: ['llm'] });
  const route = registered.find((row) => row !== null && typeof row === 'object' && row.path === ROUTE_PREFIX);
  const response = fakeResponse();
  await route.handler(fakeRequest('POST', ROUTE_PREFIX + '/translate', { text: 'Hello' }), response);
  const body = JSON.parse(response.payload);
  check('降级：宿主没有 llm 时路由仍答 502，而不是 500 崩溃', response.status === 502 && body.code === 'NO_LLM_SERVICE', response.payload);
}

// 路由层的引擎选择（假 fetch 喂真实形状的响应，不联网）
{
  const microsoftBody = [{ detectedLanguage: { language: 'en', score: 1 }, translations: [{ text: '微软译文', to: 'zh-Hans' }] }];
  const googleBody = { sentences: [{ trans: '谷歌译文', orig: 'Hi' }], src: 'en' };
  const calls = [];
  const fakeFetch = (url, init) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.includes('edge.microsoft.com/translate/auth')) return Promise.resolve({ status: 200, text: () => Promise.resolve('jwt-token') });
    if (target.includes('translate.googleapis.com')) return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(googleBody)) });
    if (target.includes('api-edge')) return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(microsoftBody)) });
    return Promise.resolve({ status: 404, text: () => Promise.resolve('') });
  };
  const { handler } = makeHandler({ config: resolveConfig({ engines: ['microsoft', 'google', 'llm'] }), fetch: fakeFetch });

  const auto = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello' });
  check('路由：auto 命中第一个可用引擎（微软）', auto.obj.state === 'done' && auto.obj.engine.id === 'microsoft' && auto.obj.text === '微软译文', JSON.stringify(auto.obj));
  check(
    '路由：微软路径先取 token 再翻译',
    calls.length === 2 && calls[0].url.includes('translate/auth') && calls[1].url.includes('api-edge'),
    JSON.stringify(calls.map((row) => row.url)),
  );
  check('路由：带上 Bearer token', String(calls[1].init.headers.authorization).startsWith('Bearer jwt-token'), String(calls[1].init.headers.authorization));
  check('路由：目标语言换成微软的代码（zh-CN → zh-Hans，不认 zh-CN）', calls[1].url.includes('to=zh-Hans'), calls[1].url);

  const google = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', engine: 'google' });
  check('路由：指定 google 时走 Google 端点', google.obj.state === 'done' && google.obj.text === '谷歌译文' && google.obj.engine.id === 'google', JSON.stringify(google.obj));
  check(
    '路由：Google 端点带 dj=1 与目标语言',
    calls.some((row) => row.url.includes('translate.googleapis.com') && row.url.includes('dj=1') && row.url.includes('tl=zh-CN')),
    JSON.stringify(calls.map((row) => row.url).filter((url) => url.includes('googleapis'))),
  );

  const bogus = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', engine: 'baidu' });
  check('路由：未知引擎 → 502 + UNKNOWN_ENGINE（而不是静默回落到 auto）', bogus.status === 502 && bogus.obj.code === 'UNKNOWN_ENGINE', JSON.stringify(bogus.obj));

  const again = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello' });
  check('路由：同文本同引擎命中缓存', again.obj.cached === true, JSON.stringify(again.obj));
  check(
    '路由：同文本换引擎不命中缓存（两家的译文要能分别取到）',
    google.obj.cached === undefined,
    JSON.stringify({ googleCached: google.obj.cached }),
  );
  const googleAgain = await handler('POST', ROUTE_PREFIX + '/translate', { text: 'Hello', engine: 'google' });
  check('路由：指定引擎同样按引擎缓存', googleAgain.obj.cached === true, JSON.stringify(googleAgain.obj));
}

summary('宿主引擎与路由');

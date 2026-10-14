/**
 * 传统翻译引擎（微软 / Google）的单测。
 *
 * 全部用**假 fetch** 驱动，不联网：真实端点在写这份测试时是无法稳定验证的
 * （实测这台机器上 Google 域名不可达，微软可达），所以这里锁住的是我们自己的
 * 契约 —— 请求怎么拼、响应怎么解析、token 怎么缓存与重试、失败怎么翻译成人话、
 * 顺序回退怎么走。这些一旦错了，表现是"有时能用有时不能"，最难查。
 *
 * 覆盖点对应真实会踩的坑：
 *   · 微软不认 `zh-CN`（要 `zh-Hans`），Google 认 —— 映射错了会翻成别的语言；
 *   · 免费 token 10 分钟过期 → 必须缓存，且 401 时要换一个再试一次；
 *   · Google 免费端点是 GET，文本进 URL → 超长必须明确失败而不是发出去被截断；
 *   · 429/403/5xx/网络不可达要给出**不同的** code，用户才知道该等、该换引擎还是该配代理；
 *   · 自动模式要把每家的原因都列出来，而不是只说"全都失败了"。
 */
import {
  DEFAULT_ORDER,
  ENGINE_LABELS,
  cookieHeaderOf,
  createBingParamsCache,
  createMicrosoftTokenCache,
  describeEngines,
  httpFailure,
  networkFailure,
  normalizeOrder,
  parseBingParams,
  parseGoogleBody,
  parseMicrosoftBody,
  runAuto,
  runEngine,
  runGoogle,
  runMicrosoft,
  runWithEngine,
  sourceCodeFor,
  languageCodeFor,
} from '../lib/engines.js';

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

// ----------------------------------------------------------------- 假 fetch

/** 造一个假 fetch：`routes` 是按 URL 子串匹配的处理器表。 */
function fakeFetch(routes) {
  const calls = [];
  const impl = (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init ?? {} });
    for (const [needle, handler] of routes) {
      if (target.includes(needle)) return Promise.resolve(handler(target, init ?? {}));
    }
    return Promise.resolve({ status: 404, text: () => Promise.resolve('') });
  };
  impl.calls = calls;
  return impl;
}

/** 一个 200 + JSON 文本的响应。 */
const json200 = (value) => ({ status: 200, text: () => Promise.resolve(JSON.stringify(value)) });
/** 一个 200 + 纯文本的响应（取 token 用）。 */
const text200 = (value) => ({ status: 200, text: () => Promise.resolve(value) });
/** 一个指定状态、空 body 的响应。 */
const statusOnly = (status) => ({ status, text: () => Promise.resolve('') });

const microsoftOk = () => json200([{ detectedLanguage: { language: 'en', score: 1 }, translations: [{ text: '你好，世界', to: 'zh-Hans' }] }]);
const googleOk = () => json200({ sentences: [{ trans: '你好，世界', orig: 'Hello' }], src: 'en' });

/** 微软免费端点的路由表；`extra` 里的规则**优先**（用来覆盖默认成功响应）。 */
const msRoutes = (extra) => [...(extra ?? []), ['edge.microsoft.com/translate/auth', () => text200('jwt-abc')], ['api-edge.', () => microsoftOk()]];

// ----------------------------------------------------------------- 目标语言映射

check('语言码：微软把中文分 Hans/Hant（不认 zh-CN）', languageCodeFor('microsoft', 'zh-CN') === 'zh-Hans' && languageCodeFor('microsoft', 'zh-TW') === 'zh-Hant');
check('语言码：Google 用 zh-CN/zh-TW', languageCodeFor('google', 'zh-CN') === 'zh-CN' && languageCodeFor('google', 'zh-TW') === 'zh-TW');
check('语言码：英日是两家通用的', languageCodeFor('microsoft', 'en') === 'en' && languageCodeFor('google', 'ja') === 'ja');
check('语言码：没映射的语言回落而不是发出去（避免翻成别的语言）', languageCodeFor('microsoft', 'klingon') === 'zh-Hans' && languageCodeFor('google', 'klingon') === 'zh-CN');
check('语言码：空目标也回落', languageCodeFor('microsoft', '') === 'zh-Hans' && languageCodeFor('google', undefined) === 'zh-CN');

// 语言表扩充后：没进例外表的规范语言要**原样透传**（两家都接受 ISO-639-1），
// 而不是回落成中文 —— 否则"选了瑞典语却拿到中文译文"这种静默错译会复活
check(
  '语言码：表里没有的规范语言原样透传（不回落中文）',
  languageCodeFor('microsoft', 'sv') === 'sv' && languageCodeFor('google', 'th') === 'th' && languageCodeFor('microsoft', 'vi') === 'vi' && languageCodeFor('google', 'uk') === 'uk',
  [languageCodeFor('microsoft', 'sv'), languageCodeFor('google', 'th')].join(','),
);
check('语言码：带地区的写法也能透传', languageCodeFor('google', 'pt-BR') === 'pt-BR' && languageCodeFor('microsoft', 'en-GB') === 'en-GB');
check(
  '语言码：例外表覆盖各家特殊写法',
  languageCodeFor('microsoft', 'sr') === 'sr-Cyrl' &&
    languageCodeFor('microsoft', 'mn') === 'mn-Cyrl' &&
    languageCodeFor('microsoft', 'no') === 'nb' &&
    languageCodeFor('microsoft', 'zh-HK') === 'zh-Hant' &&
    languageCodeFor('google', 'fil') === 'tl' &&
    languageCodeFor('google', 'zh-HK') === 'zh-TW',
  JSON.stringify({ sr: languageCodeFor('microsoft', 'sr'), fil: languageCodeFor('google', 'fil') }),
);
check(
  '错误：400 提示语言代码可能不对（语言表变长后这是最常见的 400 成因）',
  httpFailure('microsoft', 400).code === 'BAD_REQUEST' && httpFailure('microsoft', 400).message.includes('语言'),
  httpFailure('microsoft', 400).message,
);

// ----------------------------------------------------------------- 解析

check('解析（微软）：取第一条译文与检测到的语言', (() => {
  const parsed = parseMicrosoftBody([{ detectedLanguage: { language: 'en', score: 1 }, translations: [{ text: '你好', to: 'zh-Hans' }] }]);
  return parsed !== null && parsed.text === '你好' && parsed.detected === 'en';
})());
check('解析（微软）：形状不对时返回 null（不返回空串冒充成功）', parseMicrosoftBody([]) === null && parseMicrosoftBody([{}]) === null && parseMicrosoftBody({}) === null && parseMicrosoftBody(null) === null);
check('解析（微软）：译文为空串时也算失败', parseMicrosoftBody([{ translations: [{ text: '', to: 'zh-Hans' }] }]) === null);

check('解析（Google）：dj=1 的 sentences 形态', (() => {
  const parsed = parseGoogleBody({ sentences: [{ trans: '你好，' }, { trans: '世界' }], src: 'en' });
  return parsed !== null && parsed.text === '你好，世界' && parsed.detected === 'en';
})());
check('解析（Google）：经典嵌套数组形态也认（免费端点两种形状都出现过）', (() => {
  const parsed = parseGoogleBody([[['你好', 'Hello', null, null, 10]], null, 'en']);
  return parsed !== null && parsed.text === '你好' && parsed.detected === 'en';
})());
check('解析（Google）：官方 v2 的 data.translations 形态', (() => {
  const parsed = parseGoogleBody({ data: { translations: [{ translatedText: '你好', detectedSourceLanguage: 'en' }] } });
  return parsed !== null && parsed.text === '你好' && parsed.detected === 'en';
})());
check('解析（Google）：src 是 auto 时不算"检测到了语言"', parseGoogleBody({ sentences: [{ trans: 'hi' }], src: 'auto' })?.detected === undefined);
check('解析（Google）：形状不对返回 null', parseGoogleBody({}) === null && parseGoogleBody([[]]) === null && parseGoogleBody(null) === null);

// ----------------------------------------------------------------- 错误映射

check('错误：429 → 限流（提示等一会或换引擎）', httpFailure('microsoft', 429).code === 'RATE_LIMIT' && httpFailure('microsoft', 429).message.includes('频繁'));
check('错误：401/403 → 鉴权（免费端点改口径是常见原因）', httpFailure('google', 403).code === 'AUTH' && httpFailure('google', 401).message.includes('拒绝'));
check('错误：404 → 端点可能已下线', httpFailure('google', 404).code === 'ENDPOINT_MISSING');
check('错误：5xx → 上游错误', httpFailure('microsoft', 503).code === 'UPSTREAM');
check('错误：其它状态码原样带出', httpFailure('microsoft', 418).code === 'HTTP_418');
check(
  '错误：网络不可达时把排查方向写出来（Google 会点名大陆直连不通）',
  networkFailure('google', new Error('fetch failed')).code === 'UNREACHABLE' && networkFailure('google', new Error('fetch failed')).message.includes('大陆'),
  networkFailure('google', new Error('fetch failed')).message,
);
check('错误：微软的网络失败也给提示', networkFailure('microsoft', new Error('ETIMEDOUT')).message.includes('线路'));

// ----------------------------------------------------------------- 微软

{
  const fetchFn = fakeFetch(msRoutes());
  const result = await runMicrosoft({ text: 'Hello, world', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('微软：成功返回译文与引擎标识', result.state === 'done' && result.text === '你好，世界' && result.engine.id === 'microsoft', JSON.stringify(result));
  check('微软：先取 token 再翻译（两次请求）', fetchFn.calls.length === 2 && fetchFn.calls[0].url.includes('translate/auth') && fetchFn.calls[1].url.includes('api-edge'), JSON.stringify(fetchFn.calls.map((row) => row.url)));
  check('微软：翻译请求带 Bearer token 与 JSON body', String(fetchFn.calls[1].init.headers.authorization).startsWith('Bearer jwt-abc') && JSON.parse(String(fetchFn.calls[1].init.body))[0].Text === 'Hello, world');
  check('微软：URL 里有 api-version 与 to=zh-Hans', fetchFn.calls[1].url.includes('api-version=3.0') && fetchFn.calls[1].url.includes('to=zh-Hans'), fetchFn.calls[1].url);
  check('微软：带浏览器 UA（两家都会对不像浏览器的请求更苛刻）', String(fetchFn.calls[0].init.headers['user-agent']).includes('Mozilla'), String(fetchFn.calls[0].init.headers['user-agent']));
  check('微软：结果里带检测到的源语言与耗时', result.detected === 'en' && result.elapsedMs >= 0, JSON.stringify({ detected: result.detected, elapsedMs: result.elapsedMs }));
  check('微软：edge 通道成功时标注 via=edge', result.via === 'edge', String(result.via));
}

// Bing 网页版：edge 那条 404 之后的活路（实测 edge 端点已返回 404）
{
  const bingPage = '<html><script>var params_AbusePreventionHelper = [1712345678, "tok-xyz", 3600000];</script>IG:"ABCDEF123";</html>';
  const fetchFn = fakeFetch([
    ['translate/auth', () => statusOnly(404)],
    ['edge.microsoft.com', () => statusOnly(404)],
    ['/translator', () => ({ status: 200, text: () => Promise.resolve(bingPage), headers: { getSetCookie: () => ['MUID=abc; path=/; domain=.bing.com', '_EDGE_S=def; path=/'] } })],
    ['ttranslatev3', () => microsoftOk()],
  ]);
  const result = await runMicrosoft({ text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('微软：edge 404 时自动落到 Bing 网页版', result.state === 'done' && result.via === 'bing', JSON.stringify({ state: result.state, via: result.via }));
  check(
    '微软：结果里记录了 edge 那次失败（用户能看到为什么多花了一个来回）',
    Array.isArray(result.attempts) && result.attempts.length === 1 && result.attempts[0].includes('404'),
    JSON.stringify(result.attempts),
  );

  const translateCall = fetchFn.calls.filter((row) => row.url.includes('ttranslatev3'))[0];
  check(
    'Bing：请求体带 fromLang/text/to/token/key',
    (() => {
      const body = new URLSearchParams(String(translateCall.init.body));
      return (
        body.get('text') === 'Hello' &&
        body.get('to') === 'zh-Hans' &&
        body.get('token') === 'tok-xyz' &&
        body.get('key') === '1712345678' &&
        body.get('fromLang') === 'auto-detect'
      );
    })(),
    String(translateCall.init.body),
  );
  check('Bing：查询串带 IG 与 IID', translateCall.url.includes('IG=ABCDEF123') && translateCall.url.includes('IID='), translateCall.url);
  check(
    'Bing：把页面给的 Cookie 带回去（会话延续）',
    String(translateCall.init.headers.cookie).includes('MUID=abc') && String(translateCall.init.headers.cookie).includes('_EDGE_S=def'),
    String(translateCall.init.headers.cookie),
  );
  check('Bing：带 referer/origin（否则容易被判为爬虫）', translateCall.init.headers.referer.includes('/translator') && translateCall.init.headers.origin === 'https://cn.bing.com');
}

{
  // 页面里没有参数：要明确说"页面结构变了"，而不是发一个必然被拒的请求
  const fetchFn = fakeFetch([
    ['translate/auth', () => statusOnly(404)],
    ['/translator', () => ({ status: 200, text: () => Promise.resolve('<html>no params here</html>'), headers: {} })],
  ]);
  const result = await runMicrosoft({ text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('微软：两条免费通道都失败时给出聚合原因', result.state === 'error' && result.code === 'ALL_FREE_CHANNELS_FAILED', String(result.code));
  check('微软：聚合原因里两条通道都点名了', result.error.includes('edge') && result.error.includes('Bing'), result.error);
  check('微软：Bing 的失败原因说清了是"页面结构变了"', result.error.includes('页面结构'), result.error);
  check('微软：页面参数拿不到时不再白发一次翻译请求', fetchFn.calls.filter((row) => row.url.includes('ttranslatev3')).length === 0, String(fetchFn.calls.length));
}

{
  check(
    'Bing 解析：能从页面里取出 key/token/IG',
    (() => {
      const parsed = parseBingParams('x params_AbusePreventionHelper = [12345, "tok", 3600000]; y IG:"IGVALUE" z');
      return parsed !== null && parsed.key === '12345' && parsed.token === 'tok' && parsed.ig === 'IGVALUE';
    })(),
  );  check(
    'Bing 解析：没有 IG 时也算可用（IG 只用于查询串）',
    (() => {
      const parsed = parseBingParams('params_AbusePreventionHelper=[1,"t",1]');
      return parsed !== null && parsed.key === '1' && parsed.ig === '';
    })(),
  );
  check(
    'Bing 解析：缺 helper 时返回 null（调用方据此报"页面结构变了"）',
    parseBingParams('<html></html>') === null && parseBingParams('') === null && parseBingParams(undefined) === null,
  );
}

{
  check('Cookie：优先用 getSetCookie', cookieHeaderOf({ headers: { getSetCookie: () => ['A=1; path=/', 'B=2; path=/x'] } }) === 'A=1; B=2');
  check('Cookie：退回 raw()', cookieHeaderOf({ headers: { raw: () => ({ 'set-cookie': ['C=3; path=/'] }) } }) === 'C=3');
  check('Cookie：没有 headers / 格式不对时给空串（不抛）', cookieHeaderOf({}) === '' && cookieHeaderOf(null) === '' && cookieHeaderOf({ headers: { getSetCookie: () => 'nope' } }) === '');
  check('Cookie：丢掉没有等号的碎片', cookieHeaderOf({ headers: { getSetCookie: () => ['Secure', 'D=4; path=/'] } }) === 'D=4');
}

{
  // 页面参数缓存：连续翻译只抓一次页面（每条翻译都抓会白多一个来回）
  const bingPage = '<html>params_AbusePreventionHelper = [9, "tok9", 3600000]; IG:"IG9"</html>';
  const fetchFn = fakeFetch([
    ['translate/auth', () => statusOnly(404)],
    ['/translator', () => ({ status: 200, text: () => Promise.resolve(bingPage), headers: { getSetCookie: () => ['MUID=z; path=/'] } })],
    ['ttranslatev3', () => microsoftOk()],
  ]);
  const bingCache = createBingParamsCache();
  const first = await runMicrosoft({ text: 'a', target: 'zh-CN' }, { fetch: fetchFn, config: {}, bingCache });
  const second = await runMicrosoft({ text: 'b', target: 'zh-CN' }, { fetch: fetchFn, config: {}, bingCache });
  const pageCalls = fetchFn.calls.filter((row) => row.url.includes('/translator')).length;
  check('Bing 缓存：两次翻译只抓一次页面', first.state === 'done' && second.state === 'done' && pageCalls === 1, `page=${pageCalls} 总请求=${fetchFn.calls.length}`);
  check('Bing 缓存：缓存里 key/token/IG 都在', bingCache.peek()?.params.token === 'tok9' && bingCache.peek()?.params.ig === 'IG9', JSON.stringify(bingCache.peek()?.params));
  check('Bing 缓存：Cookie 也一起留着', String(bingCache.peek()?.cookie).includes('MUID=z'), String(bingCache.peek()?.cookie));
}

{
  // 页面参数提前失效：ttranslatev3 回 401 → 换一份参数重试一次
  let translateHits = 0;
  let pageHits = 0;
  const fetchFn = fakeFetch([
    ['translate/auth', () => statusOnly(404)],
    [
      '/translator',
      () => {
        pageHits++;
        return { status: 200, text: () => Promise.resolve('params_AbusePreventionHelper=[7,"tok' + pageHits + '",1]; IG:"IG' + pageHits + '"'), headers: {} };
      },
    ],
    [
      'ttranslatev3',
      () => {
        translateHits++;
        return translateHits === 1 ? statusOnly(401) : microsoftOk();
      },
    ],
  ]);
  const result = await runMicrosoft({ text: 'a', target: 'zh-CN' }, { fetch: fetchFn, config: {}, bingCache: createBingParamsCache() });
  check('Bing：401 时换一份页面参数重试一次并成功', result.state === 'done' && result.via === 'bing', JSON.stringify({ state: result.state, via: result.via }));
  check('Bing：重试确实重新抓了页面（page=2、translate=2）', pageHits === 2 && translateHits === 2, `page=${pageHits} translate=${translateHits}`);
}

{
  // token 要缓存：第二次翻译不该再取一次 token
  const fetchFn = fakeFetch(msRoutes());
  const tokenCache = createMicrosoftTokenCache();
  await runMicrosoft({ text: 'a', target: 'zh-CN' }, { fetch: fetchFn, config: {}, tokenCache });
  await runMicrosoft({ text: 'b', target: 'zh-CN' }, { fetch: fetchFn, config: {}, tokenCache });
  const authCalls = fetchFn.calls.filter((row) => row.url.includes('translate/auth')).length;
  check('微软：token 被缓存（两次翻译只取一次 token）', authCalls === 1, `auth=${authCalls} 总请求=${fetchFn.calls.length}`);
  check('微软：缓存对象能读出当前 token', tokenCache.peek() === 'jwt-abc', String(tokenCache.peek()));
}

{
  // token 过期：401 时换一个再试一次
  let translateHits = 0;
  const fetchFn = fakeFetch([
    ['edge.microsoft.com/translate/auth', () => text200('jwt-' + (++translateHits))],
    ['api-edge.', () => (translateHits === 1 ? statusOnly(401) : microsoftOk())],
  ]);
  const result = await runMicrosoft({ text: 'x', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('微软：401 时换一个 token 重试一次并成功', result.state === 'done' && result.text === '你好，世界', JSON.stringify(result).slice(0, 140));
  check('微软：401 重试路径共取两次 token、打两次翻译', fetchFn.calls.filter((row) => row.url.includes('auth')).length === 2 && fetchFn.calls.filter((row) => row.url.includes('api-edge')).length === 2, JSON.stringify(fetchFn.calls.map((row) => row.url)));
}

{
  // edge 限流之后还会去试 Bing 网页版；两条都失败时给聚合信息（含各自原因）
  const fetchFn = fakeFetch(msRoutes([['api-edge.', () => statusOnly(429)]]));
  const result = await runMicrosoft({ text: 'x', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('微软：edge 限流且 Bing 也不可用时给出聚合失败', result.state === 'error' && result.code === 'ALL_FREE_CHANNELS_FAILED', String(result.code));
  check('微软：聚合信息里保留了"请求过于频繁"这个具体原因', result.error.includes('频繁'), result.error);
  check('微软：两次失败都记进了 attempts', Array.isArray(result.attempts) && result.attempts.length === 2, JSON.stringify(result.attempts));
}

{
  const fetchFn = () => Promise.reject(new Error('getaddrinfo ENOTFOUND edge.microsoft.com'));
  const result = await runMicrosoft({ text: 'x', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('微软：网络失败时把底层原因带出来', result.state === 'error' && result.error.includes('ENOTFOUND'), result.error.slice(0, 120));
  check('微软：网络失败归类为 UNREACHABLE（在 attempts 里保留）', result.attempts[0].includes('网络不可达'), JSON.stringify(result.attempts));
}

{
  const fetchFn = fakeFetch(msRoutes([['api-edge.', () => json200([{}])]]));
  const result = await runMicrosoft({ text: 'x', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('微软：edge 响应解析不出来时不冒充成功', result.state === 'error' && result.error.includes('没有返回可用的译文'), JSON.stringify(result.code));
}

{
  // 配了 Azure key：不取 token，改走官方端点 + Ocp-Apim-Subscription-Key
  const fetchFn = fakeFetch([['api.cognitive.microsofttranslator.com', () => microsoftOk()]]);
  const result = await runMicrosoft({ text: 'x', target: 'zh-CN' }, { fetch: fetchFn, config: { microsoftApiKey: 'KEY', microsoftRegion: 'eastasia' } });
  check('微软（官方）：走 Azure 端点并成功', result.state === 'done' && result.official === true, JSON.stringify(result).slice(0, 140));
  check('微软（官方）：带订阅 key 与区域头', fetchFn.calls[0].init.headers['Ocp-Apim-Subscription-Key'] === 'KEY' && fetchFn.calls[0].init.headers['Ocp-Apim-Subscription-Region'] === 'eastasia');
  check('微软（官方）：不再请求 token', fetchFn.calls.every((row) => !row.url.includes('translate/auth')), JSON.stringify(fetchFn.calls.map((row) => row.url)));
}

// ----------------------------------------------------------------- Google

{
  const fetchFn = fakeFetch([['translate.googleapis.com', () => googleOk()]]);
  const result = await runGoogle({ text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('Google：成功返回译文与引擎标识', result.state === 'done' && result.text === '你好，世界' && result.engine.id === 'google', JSON.stringify(result));
  check('Google：免费端点用 GET 且带 client/dj/tl', fetchFn.calls[0].init.method === 'GET' && fetchFn.calls[0].url.includes('client=gtx') && fetchFn.calls[0].url.includes('dj=1') && fetchFn.calls[0].url.includes('tl=zh-CN'), fetchFn.calls[0].url);
  check('Google：文本进查询串（URL 编码）', fetchFn.calls[0].url.includes('q=Hello'), fetchFn.calls[0].url);
}

{
  const fetchFn = fakeFetch([['translate.googleapis.com', () => statusOnly(429)]]);
  const result = await runGoogle({ text: 'x', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('Google：429 也映射成限流', result.state === 'error' && result.code === 'RATE_LIMIT');
}

{
  const fetchFn = () => Promise.reject(new Error('fetch failed'));
  const result = await runGoogle({ text: 'x', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('Google：不可达时点名"大陆直连不通"（这台机器实测如此）', result.state === 'error' && result.code === 'UNREACHABLE' && result.error.includes('大陆'), result.error);
}

{
  // 超长文本：GET 装不下，必须明确失败而不是发出去被截断
  const fetchFn = fakeFetch([['translate.googleapis.com', () => googleOk()]]);
  const result = await runGoogle({ text: 'x'.repeat(9000), target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('Google：超长文本明确失败（TEXT_TOO_LONG）并建议换引擎', result.state === 'error' && result.code === 'TEXT_TOO_LONG' && result.error.includes('微软'), result.error);
  check('Google：超长时不发请求', fetchFn.calls.length === 0, String(fetchFn.calls.length));

  // 反过来：中等长度（URL 还在安全范围内）不能被误判成超长
  const okFetch = fakeFetch([['translate.googleapis.com', () => googleOk()]]);
  const medium = await runGoogle({ text: 'x'.repeat(3000), target: 'zh-CN' }, { fetch: okFetch, config: {} });
  check('Google：3000 字符属于可发送范围（不误报超长）', medium.state === 'done' && okFetch.calls.length === 1, `${medium.state} calls=${okFetch.calls.length}`);
}

{
  // 官方 key：走 POST 与 key 查询参数
  const fetchFn = fakeFetch([['translation.googleapis.com', () => json200({ data: { translations: [{ translatedText: '你好' }] } })]]);
  const result = await runGoogle({ text: 'x'.repeat(4000), target: 'zh-CN' }, { fetch: fetchFn, config: { googleApiKey: 'GKEY' } });
  check('Google（官方）：走 v2 端点且成功（超长也不受 GET 限制）', result.state === 'done' && result.text === '你好' && result.official === true, JSON.stringify(result).slice(0, 140));
  check('Google（官方）：用 POST + key 参数', fetchFn.calls[0].init.method === 'POST' && fetchFn.calls[0].url.includes('key=GKEY'), fetchFn.calls[0].url);
}

// ----------------------------------------------------------------- 超时

{
  // 端点一直不响应：必须按超时收敛，而不是挂着
  const fetchFn = (url, init) =>
    new Promise((resolve, reject) => {
      if (init !== undefined && init.signal !== undefined) {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }
    });
  const result = await runMicrosoft({ text: 'x', target: 'zh-CN' }, { fetch: fetchFn, config: {}, timeoutMs: 20 });
  check('超时：微软侧按 timeoutMs 收敛（两条通道共享同一预算，不会等双份）', result.state === 'error' && result.error.includes('超时'), result.error.slice(0, 120));
  const googleResult = await runGoogle({ text: 'x', target: 'zh-CN' }, { fetch: fetchFn, config: {}, timeoutMs: 20 });
  check('超时：Google 侧同理', googleResult.state === 'error' && googleResult.code === 'TIMEOUT', JSON.stringify(googleResult));
}

// ----------------------------------------------------------------- 源语言（与目标语言分开的两个选择器）

check(
  '源语言：auto 时不写 from/sl（交给引擎自动检测）',
  sourceCodeFor('microsoft', 'auto') === '' && sourceCodeFor('google', 'auto') === '' && sourceCodeFor('google', undefined) === '',
);
check(
  '源语言：具体语言同样按引擎写法映射（微软中文要 zh-Hans）',
  sourceCodeFor('microsoft', 'zh-CN') === 'zh-Hans' && sourceCodeFor('google', 'zh-TW') === 'zh-TW' && sourceCodeFor('microsoft', 'ja') === 'ja',
);

{
  const fetchFn = fakeFetch(msRoutes());
  await runMicrosoft({ text: 'Hello', target: 'zh-CN', source: 'ja' }, { fetch: fetchFn, config: {} });
  check('微软：指定源语言时带 from=ja', fetchFn.calls[1].url.includes('from=ja'), fetchFn.calls[1].url);
}
{
  const fetchFn = fakeFetch(msRoutes());
  await runMicrosoft({ text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('微软：源语言 auto 时完全不传 from（让微软自己检测）', fetchFn.calls[1].url.includes('from=') === false, fetchFn.calls[1].url);
}
{
  const fetchFn = fakeFetch([['translate.googleapis.com', () => googleOk()]]);
  await runGoogle({ text: 'Hello', target: 'zh-CN', source: 'ko' }, { fetch: fetchFn, config: {} });
  check('Google：指定源语言时带 sl=ko', fetchFn.calls[0].url.includes('sl=ko'), fetchFn.calls[0].url);

  const autoFetch = fakeFetch([['translate.googleapis.com', () => googleOk()]]);
  await runGoogle({ text: 'Hello', target: 'zh-CN' }, { fetch: autoFetch, config: {} });
  check('Google：源语言 auto 时写 sl=auto（它的字段不能空）', autoFetch.calls[0].url.includes('sl=auto'), autoFetch.calls[0].url);
}
{
  // Bing 的字段名不一样（fromLang），且 auto 要写 auto-detect
  const bingRoutes = () => [
    ['translate/auth', () => statusOnly(404)],
    ['/translator', () => ({ status: 200, text: () => Promise.resolve('params_AbusePreventionHelper=[1,"t",1]; IG:"G"'), headers: {} })],
    ['ttranslatev3', () => microsoftOk()],
  ];
  const withSource = fakeFetch(bingRoutes());
  await runMicrosoft({ text: 'Hello', target: 'zh-CN', source: 'fr' }, { fetch: withSource, config: {} });
  const call = withSource.calls.filter((row) => row.url.includes('ttranslatev3'))[0];
  check('Bing：指定源语言时 fromLang=fr', new URLSearchParams(String(call.init.body)).get('fromLang') === 'fr', String(call.init.body));

  const autoFetch = fakeFetch(bingRoutes());
  await runMicrosoft({ text: 'Hello', target: 'zh-CN' }, { fetch: autoFetch, config: {} });
  const autoCall = autoFetch.calls.filter((row) => row.url.includes('ttranslatev3'))[0];
  check(
    'Bing：源语言 auto 时 fromLang=auto-detect',
    new URLSearchParams(String(autoCall.init.body)).get('fromLang') === 'auto-detect',
    String(autoCall.init.body),
  );
}

// ----------------------------------------------------------------- 引擎目录与调度

check('目录：三个引擎都在，且标明模式', (() => {
  const rows = describeEngines({});
  return rows.map((row) => row.id).join(',') === 'microsoft,google,llm' && rows.every((row) => row.mode !== undefined);
})(), JSON.stringify(describeEngines({}).map((row) => row.id + ':' + row.mode)));
check('目录：配了 key 就切到官方模式', describeEngines({ googleApiKey: 'k' }).find((row) => row.id === 'google').mode === 'official' && describeEngines({ microsoftApiKey: 'k' }).find((row) => row.id === 'microsoft').mode === 'azure');

check('顺序：默认是 微软 → Google → 模型', DEFAULT_ORDER.join(',') === 'microsoft,google,llm', DEFAULT_ORDER.join(','));
check('顺序：去重、丢未知、保持给出顺序', normalizeOrder(['llm', 'google', 'llm', 'baidu']).join(',') === 'llm,google', normalizeOrder(['llm', 'google', 'llm', 'baidu']).join(','));
check('顺序：空的/非法的回落默认顺序', normalizeOrder([]).join(',') === 'microsoft,google,llm' && normalizeOrder('microsoft').join(',') === 'microsoft,google,llm');

check('标识：三个引擎都有中文显示名', ENGINE_LABELS.microsoft === '微软翻译' && ENGINE_LABELS.google === 'Google 翻译' && ENGINE_LABELS.llm === '模型');

{
  const fetchFn = fakeFetch(msRoutes());
  const result = await runEngine('microsoft', { text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('调度：runEngine 能把微软跑起来', result.state === 'done' && result.text === '你好，世界');
  const unknown = await runEngine('baidu', { text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('调度：未知引擎明确报 UNKNOWN_ENGINE', unknown.state === 'error' && unknown.code === 'UNKNOWN_ENGINE', JSON.stringify(unknown));
  const noLlm = await runEngine('llm', { text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {} });
  check('调度：没注入模型路径时 llm 引擎如实失败', noLlm.state === 'error' && noLlm.code === 'NO_LLM_SERVICE');
  const llmOk = await runEngine('llm', { text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {}, runLlm: async () => ({ state: 'done', text: '模型译文', engine: { provider: 'p', model: 'm' } }) });
  check('调度：注入后 llm 结果被加上统一的 engine 标识', llmOk.state === 'done' && llmOk.engine.id === 'llm' && llmOk.engine.model === 'm', JSON.stringify(llmOk.engine));
}

{
  // 自动模式：第一家失败就换下一家，并且结果里带上失败记录（用户才知道为什么慢）
  const fetchFn = fakeFetch([
    ['edge.microsoft.com/translate/auth', () => statusOnly(429)],
    ['translate.googleapis.com', () => googleOk()],
  ]);
  const result = await runAuto({ text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {}, order: ['microsoft', 'google', 'llm'] });
  check('自动：微软限流后落到 Google 并成功', result.state === 'done' && result.engine.id === 'google', JSON.stringify(result).slice(0, 160));
  check('自动：结果里记录了前面失败过一家（attempts）', Array.isArray(result.attempts) && result.attempts.length === 1 && result.attempts[0].includes('微软'), JSON.stringify(result.attempts));
}

{
  // 三家全败：错误里要能看出每一家的原因
  const fetchFn = () => Promise.reject(new Error('fetch failed'));
  const result = await runAuto({ text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {}, order: ['microsoft', 'google', 'llm'], runLlm: async () => ({ state: 'error', code: 'ACCOUNT_QUOTA', error: '账号余额不足' }) });
  check('自动：全败时汇总每一家的原因', result.state === 'error' && result.code === 'ALL_ENGINES_FAILED' && result.attempts.length === 3, JSON.stringify(result.attempts));
  check('自动：汇总里点名了余额与不可达', result.error.includes('余额') && result.error.includes('不可达'), result.error);
  check('自动：保留第一家失败的 code 作为 cause（程序仍能分流）', result.cause === 'ALL_FREE_CHANNELS_FAILED', String(result.cause));
}

{
  // 只有一个引擎时不做包装：精确原因不能被概括埋掉
  const result = await runAuto({ text: 'x', target: 'zh-CN' }, { fetch: () => Promise.reject(new Error('x')), config: {}, order: ['llm'], runLlm: async () => ({ state: 'error', code: 'NO_LLM_SERVICE', error: '没有 llm' }) });
  check('自动：单引擎失败时原样透出（不包成 ALL_ENGINES_FAILED）', result.code === 'NO_LLM_SERVICE', JSON.stringify(result));
}

{
  const fetchFn = fakeFetch(msRoutes());
  const auto = await runWithEngine(undefined, { text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {}, order: ['microsoft', 'google', 'llm'] });
  check('入口：engine 省略 = 自动', auto.state === 'done' && auto.engine.id === 'microsoft');
  const explicit = await runWithEngine('google', { text: 'Hello', target: 'zh-CN' }, { fetch: fakeFetch([['translate.googleapis.com', () => googleOk()]]), config: {}, order: ['microsoft', 'google', 'llm'] });
  check('入口：显式指定引擎则只打那一家', explicit.state === 'done' && explicit.engine.id === 'google');
  const outside = await runWithEngine('llm', { text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {}, order: ['microsoft'], runLlm: async () => ({ state: 'done', text: 't', engine: {} }) });
  check('入口：指定顺序之外的引擎也允许（顺序只约束自动模式）', outside.state === 'done', JSON.stringify(outside).slice(0, 120));
  const bogus = await runWithEngine('baidu', { text: 'Hello', target: 'zh-CN' }, { fetch: fetchFn, config: {}, order: ['microsoft', 'google', 'llm'] });
  check('入口：未知引擎的错误里列出可用引擎', bogus.state === 'error' && bogus.error.includes('microsoft'), bogus.error);
}

summary('传统翻译引擎（微软 / Google）');

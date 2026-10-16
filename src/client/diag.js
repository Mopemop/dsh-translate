/**
 * 诊断上报：把"客户端当时看到的事实"送回宿主，暴露在 `GET /dsh-translate/api/health` 里。
 *
 * ## 为什么需要它
 *
 * "卡片不出来" / "卡片越出侧栏"这类问题**只在真实 DOM 里复现**：选区端点落在哪、
 * `[data-sidebar-right-session]` 有多宽、事件到底有没有到监听器 —— 光看代码只能猜，
 * 而猜错一次的代价是一整轮"改了但没用"。所以这里把几个关键判定点的**观测值**报给宿主，
 * 我（或任何人）读一次 `/health` 就知道当时发生了什么。
 *
 * ## 边界
 *
 *   · 只在关键判定点各报一条（划词判定、卡片边界、guest 取词），不做高频埋点；
 *   · 上报**一律吞掉失败**：诊断绝不能影响翻译本身；
 *   · 宿主侧只保留最近 20 条（环形），不会无限增长；
 *   · 不送用户内容：只送几何、布尔判定与标签名，`text` 最多带前 24 个字符。
 */
var DIAG_PATH = '/dsh-translate/api/diag';

/** 文本摘要：只留前 24 个字符，够判断"是不是同一段"即可。 */
function digest(text) {
  if (typeof text !== 'string') return '';
  return text.length <= 24 ? text : text.slice(0, 24) + '…';
}

/** 矩形摘要（四舍五入，避免一串小数淹没重点）。 */
function rectBrief(rect) {
  if (rect === null || rect === undefined) return null;
  var round = function (value) {
    return Number.isFinite(value) ? Math.round(value) : 0;
  };
  return { l: round(rect.left), t: round(rect.top), w: round(rect.width), h: round(rect.height) };
}

/**
 * 上报一条诊断。
 *
 * @param stage - 'pick' | 'bounds' | 'guest' 之类的小标签
 * @param extra - 附加字段（会做摘要处理）
 */
function reportDiag(stage, extra) {
  try {
    if (typeof fetch !== 'function') return;
    var payload = { stage: stage };
    var source = extra === null || extra === undefined ? {} : extra;
    for (var key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      var value = source[key];
      if (key === 'text') payload.text = digest(value);
      else if (key === 'rect' || key === 'panel' || key === 'bounds' || key === 'viewport') payload[key] = rectBrief(value);
      else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) payload[key] = value;
      else if (value === undefined) payload[key] = null;
    }
    fetch(DIAG_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [payload] }),
    }).then(
      function () {},
      function () {},
    );
  } catch (error) {
    /* 诊断失败绝不能影响翻译 */
  }
}

/** 元素摘要：标签名 + 类名前 40 字符（判断"选区到底落在哪"用）。 */
function elementBrief(element) {
  if (element === null || element === undefined) return null;
  var tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '?';
  var cls = typeof element.className === 'string' ? element.className.slice(0, 40) : '';
  return cls === '' ? tag : tag + '.' + cls;
}

return {
  DIAG_PATH: DIAG_PATH,
  digest: digest,
  rectBrief: rectBrief,
  elementBrief: elementBrief,
  reportDiag: reportDiag,
};

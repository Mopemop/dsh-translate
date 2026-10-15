/**
 * 几何与文本规整的单测。
 *
 * 这一层是纯函数，所以边界可以**枚举**而不是抽样：
 * 贴底必翻上、视口比卡片还窄、跨行选区取第一行、NaN 输入……
 * 这些在真实页面里都很难稳定复现，在这里一行一个。
 */
import { loadBundle, check, summary } from './harness.mjs';

const { api } = loadBundle();
const { clamp, normalizeText, clampText, rectOfRange, placeCard, viewportOf, viewportBounds, intersectBounds, boundsOfRect, CARD_WIDTH, CARD_GAP, CARD_MARGIN, MAX_TEXT_CHARS } = api;

const VIEW = { width: 1280, height: 860 };
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

// ----------------------------------------------------------------- clamp

check('clamp：区间内原样返回', clamp(5, 0, 10) === 5);
check('clamp：低于下界抬到下界', clamp(-3, 0, 10) === 0);
check('clamp：高于上界压到上界', clamp(99, 0, 10) === 10);
check('clamp：NaN 兜到下界（不是 NaN 漏出去）', clamp(Number.NaN, 4, 10) === 4);
check('clamp：undefined 兜到下界', clamp(undefined, 4, 10) === 4);
check('clamp：区间写反时仍可用', clamp(7, 10, 0) === 7, String(clamp(7, 10, 0)));

// ----------------------------------------------------------------- normalizeText

check('规整：\\r\\n 与 \\r 统一成 \\n', normalizeText('a\r\nb\rc') === 'a\nb\nc', JSON.stringify(normalizeText('a\r\nb\rc')));
check('规整：行内连续空格压成一个', normalizeText('a    b\t\tc') === 'a b c', JSON.stringify(normalizeText('a    b\t\tc')));
check('规整：全角/不换行空格也压掉', normalizeText('a\u00a0\u00a0b') === 'a b', JSON.stringify(normalizeText('a\u00a0\u00a0b')));
check('规整：行尾空白去掉，但保留换行', normalizeText('a   \n   b') === 'a\nb', JSON.stringify(normalizeText('a   \n   b')));
check('规整：连续空行最多留一个', normalizeText('a\n\n\n\n\nb') === 'a\n\nb', JSON.stringify(normalizeText('a\n\n\n\n\nb')));
check('规整：首尾整体 trim', normalizeText('\n  hello  \n') === 'hello', JSON.stringify(normalizeText('\n  hello  \n')));
check('规整：非字符串返回空串', normalizeText(undefined) === '' && normalizeText(null) === '' && normalizeText(42) === '');
check('规整：纯空白变成空串（不该弹卡片）', normalizeText('   \n\t  ') === '');

// ----------------------------------------------------------------- clampText

check('截断：未超限时不截断', clampText('abc', 10).truncated === false && clampText('abc', 10).text === 'abc');
check('截断：刚好等于上限不截断', clampText('abcd', 4).text === 'abcd' && clampText('abcd', 4).truncated === false);
check('截断：超限截到上限并置标记', clampText('abcde', 4).text === 'abcd' && clampText('abcde', 4).truncated === true);
check('截断：非法上限回落默认值', clampText('x'.repeat(MAX_TEXT_CHARS + 10), 0).truncated === true);
check('截断：默认上限是 4000 字符', MAX_TEXT_CHARS === 4000, String(MAX_TEXT_CHARS));

// ----------------------------------------------------------------- rectOfRange

check(
  '矩形：正常 rect 原样规整',
  (() => {
    const out = rectOfRange({ getBoundingClientRect: () => rect(10, 20, 100, 16) });
    return out.left === 10 && out.top === 20 && out.width === 100 && out.height === 16 && out.right === 110 && out.bottom === 36;
  })(),
);
check(
  '矩形：全 0 时回落到第一行（跨行选区取首行更贴"文本下方"）',
  (() => {
    const out = rectOfRange({
      getBoundingClientRect: () => rect(0, 0, 0, 0),
      getClientRects: () => [rect(50, 300, 200, 18), rect(0, 320, 900, 18)],
    });
    return out.left === 50 && out.top === 300 && out.width === 200;
  })(),
);
check(
  '矩形：完全没有 rect 能力时给零矩形（不是 undefined）',
  (() => {
    const out = rectOfRange(null);
    return out.left === 0 && out.top === 0 && out.width === 0 && out.height === 0;
  })(),
);
check(
  '矩形：字段是 NaN 时兜成 0，绝不外泄 NaN',
  (() => {
    const out = rectOfRange({ getBoundingClientRect: () => ({ left: Number.NaN, top: 5, width: Number.NaN, height: Number.NaN }) });
    return Number.isFinite(out.left) && Number.isFinite(out.width) && Number.isFinite(out.height) && out.top === 5;
  })(),
);
check(
  '矩形：只有 right/bottom 时能反推宽高',
  (() => {
    const out = rectOfRange({ getBoundingClientRect: () => ({ left: 10, top: 20, right: 110, bottom: 40 }) });
    return out.width === 100 && out.height === 20;
  })(),
);

// ----------------------------------------------------------------- viewportOf

check('视口：拿不到窗口时给保守默认', viewportOf(null).width === 1024 && viewportOf(null).height === 768);
check('视口：innerWidth 为 0 时回落默认', viewportOf({ innerWidth: 0, innerHeight: 0 }).width === 1024);
check('视口：正常取值', viewportOf({ innerWidth: 800, innerHeight: 600 }).width === 800);

// ----------------------------------------------------------------- placeCard

const anchor = rect(400, 300, 200, 20); // 选区：x 400..600，y 300..320

{
  const box = placeCard(anchor, { height: 180 }, VIEW);
  check('落点：默认贴选区正下方', box.placement === 'below', box.placement);
  check('落点：下方位置 = 选区底边 + 间距', box.top === anchor.bottom + CARD_GAP, `${box.top} vs ${anchor.bottom + CARD_GAP}`);
  check('落点：水平居中于选区', box.left === Math.round(400 + 100 - CARD_WIDTH / 2), String(box.left));
  check('落点：宽度就是卡片默认宽度（视口够宽）', box.width === CARD_WIDTH, String(box.width));
}

{
  // 贴到视口底部：下方只剩 30px，放不下 180px 的卡片 → 必须翻到上方
  const low = rect(400, 800, 200, 20);
  const box = placeCard(low, { height: 180 }, VIEW);
  check('落点：下方放不下时翻到上方', box.placement === 'above', box.placement);
  check('落点：上方位置 = 选区顶边 - 间距 - 卡片高', box.top === low.top - CARD_GAP - 180, `${box.top} vs ${low.top - CARD_GAP - 180}`);
}

{
  // 上下都放不下（选区高得离谱）：夹进视口，绝不跑出屏幕
  const huge = rect(400, 10, 200, 840);
  const box = placeCard(huge, { height: 300 }, VIEW);
  check('落点：上下都放不下时夹回视口内', box.top >= CARD_MARGIN && box.top + 300 <= VIEW.height - CARD_MARGIN, `top=${box.top}`);
}

{
  const box = placeCard(rect(0, 300, 20, 20), { height: 180 }, VIEW);
  check('落点：贴左边缘时不越界', box.left >= CARD_MARGIN, String(box.left));
  const right = placeCard(rect(1270, 300, 10, 20), { height: 180 }, VIEW);
  check('落点：贴右边缘时不越界', right.left + right.width <= VIEW.width - CARD_MARGIN, `left=${right.left} width=${right.width}`);
}

{
  const narrow = { width: 260, height: 600 };
  const box = placeCard(rect(120, 200, 40, 18), { height: 160 }, narrow);
  check('落点：视口比卡片窄时收缩宽度', box.width < CARD_WIDTH && box.width <= narrow.width - CARD_MARGIN * 2, `width=${box.width}`);
  check('落点：收缩后仍不越界', box.left >= CARD_MARGIN && box.left + box.width <= narrow.width - CARD_MARGIN, `left=${box.left}`);
}

{
  const box = placeCard(anchor, { height: 0 }, VIEW);
  check('落点：首帧高度未知（0）时也贴下方', box.placement === 'below' && box.top === anchor.bottom + CARD_GAP);
  check('落点：首帧不产生 NaN', Number.isFinite(box.left) && Number.isFinite(box.top));
}

{
  // 卡片比视口还高：放不下是事实，但**顶部必须可见**（钉在留白处，超出的部分靠卡片自己滚）
  const tall = { width: 900, height: 400 };
  const box = placeCard(rect(100, 380, 200, 18), { height: 900 }, tall);
  check('落点：卡片比视口高时钉在顶部（不能被推到屏幕外）', box.top === CARD_MARGIN, String(box.top));
  check('落点：卡片比视口高时水平仍然居中且不越界', box.left >= CARD_MARGIN && box.left + box.width <= tall.width - CARD_MARGIN, `left=${box.left} width=${box.width}`);
}

{
  // 伪随机遍历：任何输入都不能产出 NaN，且该可见的必须可见
  let seed = 20261014;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let bad = null;
  let outOfView = null;
  for (let i = 0; i < 2000; i++) {
    const view = { width: 200 + Math.round(next() * 1600), height: 160 + Math.round(next() * 1200) };
    const a = rect(Math.round((next() - 0.2) * view.width), Math.round((next() - 0.2) * view.height), Math.round(next() * 600), Math.round(next() * 40));
    const size = { height: Math.round(next() * 700) };
    const box = placeCard(a, size, view);
    if (!Number.isFinite(box.left) || !Number.isFinite(box.top) || !Number.isFinite(box.width)) {
      bad = JSON.stringify({ view, a, size, box });
      break;
    }
    // 不变量 ①：卡片顶部永远在视口内（哪怕高得放不下）
    if (box.top < CARD_MARGIN - 0.5 || box.top > view.height + 0.5) {
      outOfView = `顶部越界 ${JSON.stringify({ view, a, size, box })}`;
      break;
    }
    // 不变量 ②：宽度收得进视口时，水平必须完全在视口内
    if (box.width <= view.width && (box.left < CARD_MARGIN - 0.5 || box.left + box.width > view.width - CARD_MARGIN + 0.5)) {
      outOfView = `水平越界 ${JSON.stringify({ view, a, size, box })}`;
      break;
    }
    // 不变量 ③：装得下就必须完整装下
    if (size.height <= view.height - CARD_MARGIN * 2 && box.top + size.height > view.height - CARD_MARGIN + 0.5) {
      outOfView = `垂直溢出 ${JSON.stringify({ view, a, size, box })}`;
      break;
    }
  }
  check('落点：2000 组随机输入全部有限', bad === null, bad ?? '全部有限');
  check('落点：2000 组随机输入全部满足可见性不变量', outOfView === null, outOfView ?? '顶部可见 + 装得下就装下 + 水平不越界');
}

// ----------------------------------------------------------------- 边界（卡片要留在侧栏里）

{
  check('边界：视口转边界矩形（原点 0,0）', (() => {
    const b = viewportBounds({ width: 1280, height: 860 });
    return b.left === 0 && b.top === 0 && b.right === 1280 && b.bottom === 860 && b.width === 1280;
  })());
  check('边界：视口缺失时给保守默认值', (() => {
    const b = viewportBounds(null);
    return b.width === 1024 && b.height === 768;
  })());

  check('边界：交集取更小的一块', (() => {
    const out = intersectBounds(boundsOfRect(rect(0, 0, 1000, 800)), boundsOfRect(rect(700, 100, 300, 500)));
    return out.left === 700 && out.top === 100 && out.right === 1000 && out.bottom === 600 && out.width === 300 && out.height === 500;
  })());
  check('边界：不相交时返回 null（调用方据此退让，而不是拿负宽高）', intersectBounds(boundsOfRect(rect(0, 0, 100, 100)), boundsOfRect(rect(500, 500, 100, 100))) === null);
  check('边界：一侧缺失时返回另一侧', (() => {
    const only = boundsOfRect(rect(10, 20, 30, 40));
    return intersectBounds(null, only) === only && intersectBounds(only, undefined) === only;
  })());
  check('边界：零尺寸/NaN 的矩形视为无效', boundsOfRect(rect(0, 0, 0, 50)) === null && boundsOfRect({ left: NaN, top: 0, width: 10, height: 10 }) !== null);
}

{
  // 用户报的现象：靠侧栏右缘的选区，卡片被推到对话区上方（越出侧栏、且那部分点不动）
  const panel = boundsOfRect(rect(700, 60, 320, 520)); // 侧栏：右侧 320 宽
  const viewport = viewportBounds({ width: 1280, height: 860 });
  const bounds = intersectBounds(viewport, panel);
  const anchor = rect(980, 200, 30, 16); // 选区贴侧栏右缘
  const box = placeCard(anchor, { height: 180 }, bounds);

  check('侧栏边界：卡片左边缘不越出侧栏', box.left >= panel.left + CARD_MARGIN, `left=${box.left} panel.left=${panel.left}`);
  check('侧栏边界：卡片右边缘不越出侧栏', box.left + box.width <= panel.right - CARD_MARGIN + 0.5, `right=${box.left + box.width} panel.right=${panel.right}`);
  check('侧栏边界：卡片顶部不越出侧栏', box.top >= panel.top + CARD_MARGIN - 0.5, `top=${box.top}`);
  check('侧栏边界：宽度压到侧栏能容纳的宽度', box.width <= panel.width - CARD_MARGIN * 2, `width=${box.width} panel=${panel.width}`);

  // 同一组输入下，只按整窗夹取就会越界 —— 用这条把"为什么必须传侧栏边界"钉住
  const windowOnly = placeCard(anchor, { height: 180 }, viewport);
  check('侧栏边界：若只按整窗夹取会越出侧栏（说明这层夹取确实必要）', windowOnly.left + windowOnly.width > panel.right, `${windowOnly.left + windowOnly.width} > ${panel.right}`);

  // 侧栏底部贴边的选区：卡片要翻到上方并且仍在侧栏内
  const lowAnchor = rect(800, 545, 60, 16);
  const lowBox = placeCard(lowAnchor, { height: 300 }, bounds);
  check('侧栏边界：贴底时翻到上方且不越出侧栏', lowBox.placement === 'above' && lowBox.top + 300 <= panel.bottom - CARD_MARGIN + 0.5, JSON.stringify(lowBox));
}

summary('几何与文本规整');

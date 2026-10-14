/**
 * 样式注入。
 *
 * 浏览器半侧的 bundle 是**没有顶层 import 的普通脚本**，拿不到打包器注入的
 * CSS 管线，所以样式以文本形式随产物一起送到页面，由本模块挂一个 <style>。
 *
 * 两个细节是有意的：
 *   · 用 `data-plugin` / `data-plugin-css` 标记自己 —— 与 DSH 自带插件同一套约定，
 *     便于在 Elements 面板里一眼看出这块样式是谁的；
 *   · 重复注入直接跳过：插件被加载两次（HMR、或用户手工再加一条 entry）时，
 *     页面里只该有一份样式，否则规则数量翻倍、调试时看到的永远是旧那份。
 */

/** 样式标签的身份（同时是 data-plugin-css 的值）。 */
var STYLE_TAG = 'dsh-translate/card';

/** 构建期由 scripts/build.mjs 用 src/client/styles/client.css 的内容替换。 */
var CSS_TEXT = __CSS_TEXT__;

/** 样式文本（测试台用来断言关键规则存在）。 */
function cssText() {
  return CSS_TEXT;
}

/**
 * 注入样式。
 * @returns 卸载函数（移除这个 <style>），交给 ctx.effect 管理生命周期。
 */
function installCss() {
  if (typeof document === 'undefined' || document === null) return function () {};
  if (document.head === undefined || document.head === null) return function () {};
  var existing = typeof document.querySelector === 'function' ? document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') : null;
  if (existing !== null && existing !== undefined) return function () {};
  var tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-translate';
  tag.dataset.pluginCss = STYLE_TAG;
  tag.textContent = CSS_TEXT;
  document.head.appendChild(tag);
  return function () {
    if (tag.parentNode !== null && tag.parentNode !== undefined) tag.parentNode.removeChild(tag);
  };
}

return {
  STYLE_TAG: STYLE_TAG,
  cssText: cssText,
  installCss: installCss,
};

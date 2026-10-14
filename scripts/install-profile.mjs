/**
 * 把 dsh-translate 挂进 DSH 的 desktop profile（幂等，可重复执行）。
 *
 * ## 它做三件事
 *
 *   1. 在 profile 的 `package.json` 里声明依赖：
 *        "dsh-translate": "link:<本包绝对路径>"
 *   2. 把 "dsh-translate" 加进 `dsh.profile.bundles`（追加到层栈最后一位）
 *   3. 在 profile 的 `node_modules/` 下建一个 **junction** 指向本包
 *      —— 不必跑 pnpm install 就能让 DSH 解析到这个包；将来用户自己跑
 *      `pnpm install` 时，pnpm 会按 package.json 的 link: 重建同一件事。
 *
 * ## 为什么用 junction 而不是直接跑 pnpm install
 *
 * 这个 profile 里已经有 dsh-pet / dsh-ops / dsh-stock-kline 三个包在跑，
 * 跑一次 `pnpm install` 有可能顺带调整 lockfile 与 .ignored_* 目录 ——
 * 装一个新插件不该改动别的插件的既有状态。所以这里只做**最小必要写入**：
 * 一个依赖行、一个数组项、一个目录联接。想要标准路径就加 --no-link 自己跑 pnpm。
 *
 * ## 用法
 *
 *   node scripts/install-profile.mjs --dry-run   # 只看会改什么
 *   node scripts/install-profile.mjs             # 真改（默认 profile: desktop）
 *   DSH_PROFILE_DIR=... node scripts/install-profile.mjs
 *
 * 改完需要**重启 DSH**：bundle 层栈只在启动时叠加。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_NAME = 'dsh-translate';
const BACKUP_SUFFIX = '.bak-dsh-translate';

const dryRun = process.argv.includes('--dry-run');
const skipLink = process.argv.includes('--no-link');

const profileDir = resolve(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop'),
);
const manifestPath = join(profileDir, 'package.json');
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME);

function fail(message) {
  console.error('安装中止：' + message);
  process.exit(1);
}

/** 取符号链接/junction 指向的绝对目标；不是链接或读不出来时返回 null。 */
function linkTargetAt(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolve(dirname(path), readlinkSync(path));
  } catch (error) {
    return null;
  }
}

/** bundle 是否落后于源码（提醒先构建）。 */
function bundleIsStale() {
  try {
    const bundle = join(PACKAGE_ROOT, 'lib', 'client.js');
    if (!existsSync(bundle)) return true;
    const newestSource = ['plugin.js', 'popup.js', 'selection.js', 'scope.js', 'geometry.js', 'translate.js', 'styles.js']
      .map((file) => join(PACKAGE_ROOT, 'src', 'client', file))
      .filter((file) => existsSync(file))
      .reduce((newest, file) => Math.max(newest, statSync(file).mtimeMs), 0);
    return statSync(bundle).mtimeMs < newestSource;
  } catch (error) {
    return false;
  }
}

if (!existsSync(manifestPath)) fail(`找不到 profile 清单：${manifestPath}（可用 DSH_PROFILE_DIR 指定）`);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
// link: 规格里用正斜杠：这份清单里的路径别的工具也会读
const linkSpec = 'link:' + PACKAGE_ROOT.replace(/\\/g, '/');

manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];

const changes = [];
if (manifest.dependencies[PACKAGE_NAME] !== linkSpec) {
  changes.push(`dependencies.${PACKAGE_NAME}: ${manifest.dependencies[PACKAGE_NAME] ?? '(无)'} → ${linkSpec}`);
  manifest.dependencies[PACKAGE_NAME] = linkSpec;
}
if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) {
  changes.push(`dsh.profile.bundles: 追加 ${PACKAGE_NAME}`);
  manifest.dsh.profile.bundles.push(PACKAGE_NAME);
}

// node_modules 联接：三种状态（已是本包 / 已存在但指向别处 / 不存在）
let linkAction = 'none';
let linkNote = '';
const existingTarget = linkTargetAt(linkPath);
if (existingTarget === PACKAGE_ROOT) {
  linkNote = `已指向本包（${PACKAGE_ROOT}）`;
} else if (existsSync(linkPath) || existingTarget !== null) {
  linkNote = `已存在但目标是 ${existingTarget ?? '实体目录'}，不动它（请自行确认）`;
} else if (skipLink) {
  linkNote = '按 --no-link 跳过（请自行跑 pnpm install）';
} else {
  linkAction = 'create';
  linkNote = `新建 junction → ${PACKAGE_ROOT}`;
}

console.log(`profile： ${profileDir}`);
console.log(`本包：   ${PACKAGE_ROOT}`);
console.log('清单改动：');
if (changes.length === 0) console.log('  ·（已是最新，无需改动）');
for (const line of changes) console.log('  · ' + line);
console.log(`node_modules/${PACKAGE_NAME}：${linkNote}`);

if (bundleIsStale()) console.log('注意：lib/client.js 落后于 src/，先跑 node scripts/build.mjs');

if (dryRun) {
  console.log('\n--dry-run：没有写入任何文件。');
  process.exit(0);
}

if (changes.length > 0) {
  const backupPath = manifestPath + BACKUP_SUFFIX;
  if (existsSync(backupPath)) {
    console.log(`备份已存在，保留原样 → ${backupPath}`);
  } else {
    copyFileSync(manifestPath, backupPath);
    console.log(`已备份原清单 → ${backupPath}`);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('已写入 profile 清单。');
}

if (linkAction === 'create') {
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  try {
    // Windows 用 junction：不需要管理员权限，也不需要开发者模式
    symlinkSync(PACKAGE_ROOT, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    console.log('已建立 node_modules 联接。');
  } catch (error) {
    fail(`建立联接失败（${error instanceof Error ? error.message : String(error)}）—— 可改用 pnpm install 走标准路径`);
  }
}

console.log('\n下一步：重启 DSH（bundle 层栈只在启动时叠加）。');
console.log('重启后在右侧栏打开 Markdown / 代码 / 文本 / PDF，选中一段文字即可看到卡片。');

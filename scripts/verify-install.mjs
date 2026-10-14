/**
 * 安装自检：确认 DSH 启动时**真的能**找到这个插件。
 *
 * 安装脚本写的是三处声明（依赖行、bundles 项、node_modules 联接），
 * 但"声明对了"不等于"能解析到" —— 路径大小写、exports 映射、联接目标写错，
 * 都会表现为"重启后插件不出现"，而那时排查成本很高。这里在安装后立刻按
 * DSH 自己的解析方式（从 profile 目录做模块解析）验一遍：
 *
 *   1. profile 清单里有依赖行与 bundles 项；
 *   2. `dsh-translate` 能解析到本包（走 node_modules 联接）；
 *   3. `dsh-translate/client` 能解析到 lib/client.js，且产物已注册到 __ModuleLoader__；
 *   4. 宿主半侧入口 lib/index.js 存在且声明了插件名。
 *
 * 用法：node scripts/verify-install.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_NAME = 'dsh-translate';

const profileDir = resolve(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop'),
);

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ' + detail}`);
  if (!ok) failures++;
}

const manifestPath = join(profileDir, 'package.json');
check('profile 清单存在', existsSync(manifestPath), manifestPath);

let manifest = {};
if (existsSync(manifestPath)) manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const declared = manifest.dependencies?.[PACKAGE_NAME];
check('清单里声明了依赖（link: 指向本包）', typeof declared === 'string' && declared.startsWith('link:'), String(declared));
if (typeof declared === 'string' && declared.startsWith('link:')) {
  const target = declared.slice('link:'.length);
  check('依赖目标就是本包目录', resolve(target) === PACKAGE_ROOT, `声明 ${resolve(target)} / 实际 ${PACKAGE_ROOT}`);
}
check(
  '清单里列进了 dsh.profile.bundles',
  Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(PACKAGE_NAME),
  JSON.stringify(manifest.dsh?.profile?.bundles),
);

// 按 DSH 的方式做解析：从 profile 目录起算
const requireFromProfile = createRequire(join(profileDir, 'noop.cjs'));
let hostEntry = null;
try {
  hostEntry = requireFromProfile.resolve(PACKAGE_NAME + '/package.json');
} catch (error) {
  check('能从 profile 解析到本包', false, error instanceof Error ? error.message : String(error));
}
if (hostEntry !== null) {
  check('解析到的就是本包', resolve(dirname(hostEntry)) === PACKAGE_ROOT, hostEntry);
}

let clientEntry = null;
try {
  clientEntry = requireFromProfile.resolve(PACKAGE_NAME + '/client');
} catch (error) {
  check('能解析到客户端半侧（./client 出口）', false, error instanceof Error ? error.message : String(error));
}
if (clientEntry !== null) {
  check('客户端半侧指向 lib/client.js', clientEntry === join(PACKAGE_ROOT, 'lib', 'client.js'), clientEntry);
  const bundle = readFileSync(clientEntry, 'utf8');
  check('产物体积合理（不是空文件）', bundle.length > 5000, `${bundle.length} 字符`);
  check('产物已注册到 __ModuleLoader__', bundle.includes('window.__ModuleLoader__.load('));
  check('产物注册 id 与包名一致', bundle.includes(`id: ${JSON.stringify(PACKAGE_NAME)}`));
}

const hostFile = join(PACKAGE_ROOT, 'lib', 'index.js');
check('宿主半侧入口存在', existsSync(hostFile), hostFile);
if (existsSync(hostFile)) {
  const source = readFileSync(hostFile, 'utf8');
  check('宿主半侧声明了插件名', source.includes(`'${PACKAGE_NAME}'`));
}

const patchFile = join(PACKAGE_ROOT, 'cordis.patch.yml');
check('bundle patch 存在', existsSync(patchFile), patchFile);
if (existsSync(patchFile)) {
  const patch = readFileSync(patchFile, 'utf8');
  check('patch 里有对应 entry（id 行不带行尾注释）', new RegExp(`id: ${PACKAGE_NAME}\\s*\\n`).test(patch), patch.split('\n').find((line) => line.includes('id:')));
}

console.log(`\n${failures === 0 ? '安装自检全部通过' : failures + ' 项失败'}：重启 DSH 后插件即会加载。`);
if (failures > 0) process.exitCode = 1;

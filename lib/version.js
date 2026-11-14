/**
 * 版本号解析、比较与发布渠道判定。
 *
 * DSH 的版本号是标准 semver：`0.2.2-rc.3`、`0.1.7-rc.2`、`0.2.0`。
 * 渠道从预发布标识推导（alpha / beta / rc / 正式版），不依赖 npm 的
 * dist-tags——只有 latest 与 next 两个标签不足以表达「这一版属于哪个阶段」。
 *
 * @module dsh-versions/version
 */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

/** GitHub release 的 tag 前缀。 */
const TAG_PREFIX = 'dsh-v';

/**
 * 解析一个版本号。
 * @param {unknown} text 版本号文本。
 * @returns {{major: number, minor: number, patch: number, prerelease: string[]}|undefined} 解析结果。
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return undefined;
  const match = SEMVER.exec(text.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/**
 * 比较单个预发布标识符（数字段按数值比较，其余按字典序）。
 * @param {string} a 左。
 * @param {string} b 右。
 * @returns {number} 负数表示 a < b。
 */
function compareIdentifiers(a, b) {
  const numericA = /^\d+$/u.test(a);
  const numericB = /^\d+$/u.test(b);
  if (numericA && numericB) return Number(a) - Number(b);
  if (numericA) return -1;
  if (numericB) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 按 semver 规则比较两个版本号。
 * @param {string} a 左。
 * @param {string} b 右。
 * @returns {number} 负数表示 a < b，0 表示相等。
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.prerelease[index];
    const y = right.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareIdentifiers(x, y);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * 判断版本属于哪个发布渠道。
 * @param {string} version 版本号。
 * @returns {'stable'|'alpha'|'beta'|'rc'|'other'} 渠道。
 */
export function channelOf(version) {
  const parsed = parseVersion(version);
  if (parsed === undefined) return 'other';
  if (parsed.prerelease.length === 0) return 'stable';
  const head = parsed.prerelease[0].toLowerCase();
  if (head === 'alpha' || head === 'beta' || head === 'rc') return head;
  return 'other';
}

/**
 * 是否预发布版本。
 * @param {string} version 版本号。
 * @returns {boolean} 是否预发布。
 */
export function isPrerelease(version) {
  const parsed = parseVersion(version);
  return parsed !== undefined && parsed.prerelease.length > 0;
}

/**
 * 版本号 → GitHub release tag。
 * @param {string} version 版本号。
 * @returns {string} tag。
 */
export function tagOf(version) {
  return `${TAG_PREFIX}${version}`;
}

/**
 * GitHub release tag → 版本号（不认识的前缀原样返回）。
 * @param {unknown} tag tag 文本。
 * @returns {string|undefined} 版本号。
 */
export function versionOfTag(tag) {
  if (typeof tag !== 'string' || tag === '') return undefined;
  return tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag;
}

/**
 * 按版本号从新到旧排序（不改动入参）。
 * @param {Array<{version: string}>} rows 行。
 * @returns {Array<{version: string}>} 新数组。
 */
export function sortByVersionDesc(rows) {
  return [...rows].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * 当前平台对应的官方安装包文件名后缀。
 * @param {string} platform `process.platform`。
 * @returns {string} 后缀（含点）。
 */
export function installerExtension(platform) {
  if (platform === 'win32') return '.exe';
  if (platform === 'darwin') return '.dmg';
  return '.AppImage';
}

/**
 * 当前平台在下载站的目录名（`win-x64`、`darwin-arm64`…）。
 * @param {string} platform `process.platform`。
 * @param {string} arch `process.arch`。
 * @returns {string} 目录名。
 */
export function platformDir(platform, arch) {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'darwin' : 'linux';
  return `${os}-${arch}`;
}

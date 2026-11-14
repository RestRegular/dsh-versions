/**
 * 当前运行的 DSH 版本探测。
 *
 * 这件事有个坑：`~/.dsh/dsh-runtimes/<name>/runtime.json` 的 `desktopVersion`
 * 会滞后于实际安装（应用内更新后不一定立刻刷新），实测本机已经装到
 * `0.2.2-rc.3`，那个文件里还写着 `0.2.2-rc.1`。所以它只能当**最后的兜底**，
 * 不能当主来源，否则面板会把「当前版本」标错。
 *
 * 可信度排序：
 *
 * 1. `<安装目录>/resources/app.asar` 里的 `dsh/node_modules/@deepseek-ai/dsh/package.json`
 *    —— 就是正在跑的这份 CLI，最权威。
 * 2. `<安装目录>/resources/runtime/primary-runtime/runtime.json` 的 `desktopVersion`
 *    —— 随安装包一起落地，跟着应用更新走。
 * 3. `DSH_INSTALL_DIR/package.json` —— Host 子进程里该路径指向 asar 内部，Electron
 *    的 fs 是 asar-aware 的，读得到；普通 node 进程会 ENOENT。
 * 4. `createRequire` 解析 `@deepseek-ai/dsh/package.json`（纯 CLI 安装场景）。
 * 5. `~/.dsh/dsh-runtimes/<name>/runtime.json`（可能滞后，见上）。
 *
 * 安装目录本身也不止一个线索：Host 子进程的 `process.execPath` 是桌面主程序，
 * 而 `DSH_NODE_EXECUTABLE` 环境变量在纯 node 进程里同样指着它。两个都试。
 *
 * 版本只用于界面高亮与「当前版本」标注，探测失败不影响其它功能。
 *
 * @module dsh-versions/runtime
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** asar 头最大长度，防止读到脏数据时无限分配。 */
const MAX_ASAR_HEADER = 8 * 1024 * 1024;

/** CLI 包在 asar 里的路径。 */
const ASAR_CLI_PACKAGE = 'dsh/node_modules/@deepseek-ai/dsh/package.json';

/**
 * 读一个 JSON 文件。
 * @param {string} file 路径。
 * @returns {object|undefined} 解析结果。
 */
function readJson(file) {
  try {
    return parseJsonLoose(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 宽松解析 JSON。
 *
 * 这个应用打出来的 asar 里，`package.json` 之类的条目前面会粘着上一段代码的尾巴
 * （实测 app.asar 的 `package.json` 以 `);\n{` 开头、CLI 包以 `};` 开头），直接
 * `JSON.parse` 必然失败。所以退一步：取第一个 `{` 到最后一个 `}` 之间的内容再试。
 *
 * @param {unknown} text 文本。
 * @returns {object|undefined} 解析结果。
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch {
    /* 走宽松路径 */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读 asar 归档头。
 *
 * 结构是 Chromium pickle：
 *
 * ```
 * [0..4)   u32 4
 * [4..8)   u32 payloadSize      → 数据区起点 = 8 + payloadSize
 * [8..12)  u32
 * [12..16) u32 jsonLength
 * [16..)   JSON 头（后面补 \0 对齐到 4 字节）
 * ```
 *
 * 注意数据区起点是 `8 + u32@4`，不是 `16 + jsonLength`：后者少了对齐用的
 * padding，读出来的每个条目都会带着上一段的尾巴（实测差 3 字节）。
 *
 * @param {number} fd 已打开的文件描述符。
 * @param {number} size 归档大小。
 * @returns {{header: object, base: number}|undefined} 头与数据区起点。
 */
function readAsarHeader(fd, size) {
  const prefix = Buffer.alloc(16);
  readSync(fd, prefix, 0, 16, 0);
  const payloadSize = prefix.readUInt32LE(4);
  const jsonLength = prefix.readUInt32LE(12);
  const base = 8 + payloadSize;
  if (jsonLength <= 0 || jsonLength > MAX_ASAR_HEADER) return undefined;
  if (base < 16 + jsonLength || base > size) return undefined;
  const jsonBuffer = Buffer.alloc(jsonLength);
  readSync(fd, jsonBuffer, 0, jsonLength, 16);
  const header = JSON.parse(jsonBuffer.toString('utf8').replace(/\0+$/u, ''));
  if (header === null || typeof header !== 'object') return undefined;
  return { header, base };
}

/**
 * 从 asar 归档里读一个文件的文本内容。
 *
 * 用 `openSync` + `readSync` 按偏移读：asar 有 200 MB，`readFileSync` 会把整
 * 个归档读进内存。
 *
 * @param {string} archive asar 路径。
 * @param {string} inner 归档内路径（不带前导斜杠）。
 * @returns {string|undefined} 文本。
 */
export function readFromAsar(archive, inner) {
  let fd;
  try {
    const size = statSync(archive).size;
    if (size < 16) return undefined;
    fd = openSync(archive, 'r');
    const parsed = readAsarHeader(fd, size);
    if (parsed === undefined) return undefined;
    let node = parsed.header;
    for (const segment of inner.split('/').filter((part) => part !== '')) {
      node = node?.files?.[segment];
      if (node === undefined) return undefined;
    }
    const bytes = Number(node?.size);
    const offset = Number(node?.offset);
    if (!Number.isFinite(bytes) || !Number.isFinite(offset) || bytes <= 0) return undefined;
    if (parsed.base + offset + bytes > size) return undefined;
    const buffer = Buffer.alloc(bytes);
    readSync(fd, buffer, 0, bytes, parsed.base + offset);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      /* 关闭失败无所谓 */
    }
  }
}

/**
 * 候选安装目录（去重后的绝对路径）。
 * @returns {Array<string>} 目录。
 */
function installDirCandidates() {
  const seen = new Set();
  const roots = [];
  const push = (candidate) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return;
    const root = dirname(candidate.trim());
    const key = root.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(root);
  };
  // Host 子进程：execPath 是桌面主程序。
  push(process.execPath);
  // 纯 node 进程：DSH 用这个变量告诉子进程主程序在哪。
  push(process.env.DSH_NODE_EXECUTABLE);
  return roots;
}

/**
 * 桌面版安装目录（`<resources>/app.asar` 所在目录），探测不到返回 undefined。
 * @returns {string|undefined} 目录。
 */
export function desktopInstallDir() {
  for (const root of installDirCandidates()) {
    try {
      if (statSync(join(root, 'resources', 'app.asar')).isFile()) return root;
    } catch {
      /* 下一个候选 */
    }
    try {
      if (statSync(join(root, 'resources', 'app')).isDirectory()) return root;
    } catch {
      /* 下一个候选 */
    }
  }
  return undefined;
}

/**
 * 桌面壳（Electron 应用）自己的版本。
 * @returns {string|undefined} 版本号。
 */
export function desktopShellVersion() {
  const root = desktopInstallDir();
  if (root === undefined) return undefined;
  const fromAsar = readFromAsar(join(root, 'resources', 'app.asar'), 'package.json');
  if (fromAsar !== undefined) {
    const parsed = parseJsonLoose(fromAsar);
    if (typeof parsed?.version === 'string') return parsed.version;
  }
  const fromDir = readJson(join(root, 'resources', 'app', 'package.json'));
  return typeof fromDir?.version === 'string' ? fromDir.version : undefined;
}

/**
 * 安装目录里随包落地的运行时清单（`resources/runtime/primary-runtime/runtime.json`）。
 * @returns {object|undefined} 清单。
 */
export function bundledRuntimeManifest() {
  const root = desktopInstallDir();
  if (root === undefined) return undefined;
  return readJson(join(root, 'resources', 'runtime', 'primary-runtime', 'runtime.json'));
}

/**
 * 读主运行时清单（`~/.dsh/dsh-runtimes/<name>/runtime.json`）。可能滞后，兜底用。
 * @returns {object|undefined} 清单。
 */
export function runtimeManifest() {
  const explicit = process.env.DSH_PRIMARY_RUNTIME;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const manifest = readJson(join(explicit.trim(), 'runtime.json'));
    if (manifest !== undefined) return manifest;
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return readJson(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'));
}

/**
 * 探测当前 DSH 版本。
 * @returns {{version?: string, source?: string, cliVersion?: string, desktopVersion?: string, runtimeVersion?: string}} 探测结果。
 */
export function detectCurrentVersion() {
  const result = {};
  const root = desktopInstallDir();

  // 1. asar 里的 CLI 包 —— 最权威。
  if (root !== undefined) {
    const text = readFromAsar(join(root, 'resources', 'app.asar'), ASAR_CLI_PACKAGE);
    if (text !== undefined) {
      const parsed = parseJsonLoose(text);
      if (typeof parsed?.version === 'string') {
        result.version = parsed.version;
        result.source = 'app.asar';
        result.cliVersion = parsed.version;
      }
    }
  }

  // 2. 随包落地的运行时清单。
  if (result.version === undefined) {
    const bundled = bundledRuntimeManifest();
    if (bundled !== undefined && typeof bundled.desktopVersion === 'string') {
      result.version = bundled.desktopVersion;
      result.source = 'resources/runtime';
      result.runtimeVersion = bundled.desktopVersion;
    }
  }

  // 3. Host 子进程里的 DSH_INSTALL_DIR（Electron 的 fs 是 asar-aware 的）。
  if (result.version === undefined) {
    const installDir = process.env.DSH_INSTALL_DIR;
    if (typeof installDir === 'string' && installDir.trim() !== '') {
      const manifest = readJson(join(installDir.trim(), 'package.json'));
      if (typeof manifest?.version === 'string') {
        result.version = manifest.version;
        result.source = 'DSH_INSTALL_DIR';
        result.cliVersion = manifest.version;
      }
    }
  }

  // 4. 纯 CLI 安装：直接解析包。
  if (result.version === undefined) {
    try {
      const require = createRequire(import.meta.url);
      const manifest = require('@deepseek-ai/dsh/package.json');
      if (typeof manifest?.version === 'string') {
        result.version = manifest.version;
        result.source = 'module';
        result.cliVersion = manifest.version;
      }
    } catch {
      /* 插件不依赖 CLI 包，解析失败正常 */
    }
  }

  const shell = desktopShellVersion();
  if (shell !== undefined) result.desktopVersion = shell;

  // 5. 兜底：用户目录里的运行时清单（可能滞后）。
  if (result.version === undefined) {
    const runtime = runtimeManifest();
    if (runtime !== undefined && typeof runtime.desktopVersion === 'string') {
      result.version = runtime.desktopVersion;
      result.source = 'runtime.json';
      result.runtimeVersion = runtime.desktopVersion;
    }
  }

  if (result.version === undefined && shell !== undefined) {
    result.version = shell;
    result.source = 'desktop-shell';
  }

  return result;
}

/**
 * 应用内更新通道（桌面版写在 `resources/app-update.yml` 里）。
 * @returns {{channel?: string, feedUrl?: string}} 通道信息。
 */
export function updateChannel() {
  const root = desktopInstallDir();
  if (root === undefined) return {};
  let text;
  try {
    text = readFileSync(join(root, 'resources', 'app-update.yml'), 'utf8');
  } catch {
    return {};
  }
  const channel = /^channel:\s*(\S+)/mu.exec(text)?.[1];
  const feedUrl = /^url:\s*(\S+)/mu.exec(text)?.[1];
  const result = {};
  if (channel !== undefined) result.channel = channel.replace(/^['"]|['"]$/gu, '');
  if (feedUrl !== undefined) result.feedUrl = feedUrl.replace(/^['"]|['"]$/gu, '');
  return result;
}

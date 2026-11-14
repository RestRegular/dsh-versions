/**
 * 版本切换：把「已下载的安装包」变成一次真正会自动跑完的切换。
 *
 * 切换版本的唯一正路还是官方安装程序（见 installer.js 的说明）：插件不替换
 * 文件、不碰 autoUpdater、不改 settings.json，只负责**跑对应版本的安装程序**。
 *
 * 但光把安装程序拉起来是不够的——安装程序要替换 \`DeepSeek Harness.exe\` 和
 * \`resources/**\`，而 DSH 还开着，文件被占用，于是要么弹「请先关闭应用」，要么
 * 装到一半失败，用户看到的就是「点了切换没反应」。所以现在走 apply.js 的后台
 * 任务：
 *
 * 1. 写请求参数，用 WMI 拉起一个脱离 DSH 进程树的 worker；
 * 2. worker 关掉正在运行的 DSH，等文件解锁；
 * 3. 静默跑安装程序（\`/S /currentuser /D=<安装目录>\`），失败再退回可见安装；
 * 4. 装完把新版本重新拉起来，全程写 \`apply-switch.log\`。
 *
 * 状态落在 \`<dataDir>/switch-state.json\`，走 JsonCache 的「临时文件 + rename」：
 *
 * - 请求切换时写 \`pending\`（版本 + 时间 + pid + 日志路径）；
 * - 下次探测到当前版本 === pending.version，说明切换真的生效了，落成
 *   \`applied\` 并清掉 pending；
 * - 用户中途反悔（后台任务还没关掉 DSH），可以在面板上取消这个标记。
 *
 * @module dsh-versions/switch
 */

import { basename, dirname } from 'node:path';

import { JsonCache } from './cache.js';
import { formatBytes } from './installer.js';
import { buildRequest, launchApply, readLog } from './apply.js';

/** 状态缓存名。 */
const NAME = 'switch-state';

/** 待切换标记的最长存活时间（超过就当作那次切换失败/放弃了）。 */
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;

/** 桌面主程序默认文件名（安装目录里那个可执行文件）。 */
const DEFAULT_EXE = 'DeepSeek Harness.exe';

/**
 * 猜安装目录里那个可执行文件叫什么。
 *
 * 宿主进程本身就是它，所以 \`process.execPath\` 最准；纯 node 环境下它是 node.exe，
 * 与安装目录对不上，就退回默认名。
 *
 * @param {string} installDir 安装目录。
 * @returns {string} 文件名。
 */
function resolveExeFile(installDir) {
  const execPath = process.execPath;
  if (typeof execPath === 'string' && /\.exe$/iu.test(execPath)) {
    const normalize = (value) => value.replace(/\//gu, '\\').toLowerCase();
    if (normalize(dirname(execPath)) === normalize(installDir)) return basename(execPath);
  }
  return DEFAULT_EXE;
}

/**
 * 把任意值收敛成 \`{version, at, ...}\` 形态。
 * @param {unknown} value 原始值。
 * @returns {{version: string, at?: number, path?: string, requestedAt?: number, pid?: number, logPath?: string}|undefined} 记录。
 */
function normalize(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const version = value.version;
  if (typeof version !== 'string' || version === '') return undefined;
  const result = { version };
  for (const key of ['at', 'requestedAt', 'pid']) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number > 0) result[key] = number;
  }
  for (const key of ['path', 'logPath']) {
    if (typeof value[key] === 'string' && value[key] !== '') result[key] = value[key];
  }
  return result;
}

/**
 * 切换状态的读写与「请求切换」。
 */
export class Switcher {
  /**
   * @param {{downloader: object, dir: string, logger?: object, installDir?: () => string|undefined, launcher?: (options: object) => Promise<object>}} options 选项。
   */
  constructor(options) {
    this.downloader = options.downloader;
    this.cache = new JsonCache({ dir: options.dir });
    this.dir = options.dir;
    this.logger = options.logger;
    this.installDir = typeof options.installDir === 'function' ? options.installDir : () => undefined;
    // 允许测试替换掉真正的进程拉起（它会真的去关 DSH）。
    this.launcher = typeof options.launcher === 'function' ? options.launcher : launchApply;
  }

  /**
   * 读状态（不判断是否已生效）。
   * @returns {{pending?: object, applied?: object}} 状态。
   */
  read() {
    const record = this.cache.read(NAME);
    const value = record?.value;
    if (value === null || typeof value !== 'object') return {};
    const state = {};
    const pending = normalize(value.pending);
    const applied = normalize(value.applied);
    if (pending !== undefined) state.pending = pending;
    if (applied !== undefined) state.applied = applied;
    return state;
  }

  /**
   * 写状态（丢掉 undefined 字段）。
   * @param {{pending?: object, applied?: object}} state 状态。
   * @returns {void}
   */
  write(state) {
    const value = {};
    if (state.pending !== undefined) value.pending = state.pending;
    if (state.applied !== undefined) value.applied = state.applied;
    this.cache.write(NAME, value);
  }

  /**
   * 若待切换版本已经等于正在运行的版本，说明切换生效了。
   *
   * 只读调用（面板/工具轮询）也会经过这里，所以它必须是幂等的：生效后写一次
   * \`applied\` 并清掉 pending，之后再调用不会再产生写入。
   *
   * @param {string|undefined} currentVersion 当前运行版本。
   * @returns {{pending?: object, applied?: object}} 结算后的状态。
   */
  settle(currentVersion) {
    const state = this.read();
    if (state.pending === undefined) return state;
    // 过期清理：一次切换最多几分钟。留下的陈年 pending 只会让面板一直挂着
    // 「待切换」横幅（比如后台任务被安全软件拦掉、安装包被杀毒删掉），
    // 超过 6 小时就当它没发生。
    const startedAt = state.pending.at ?? state.pending.requestedAt;
    if (typeof startedAt === 'number' && Date.now() - startedAt > PENDING_TTL_MS) {
      this.logger?.warn?.(`[dsh-versions] dropping stale pending switch to ${state.pending.version}`);
      this.write({ applied: state.applied });
      return state.applied === undefined ? {} : { applied: state.applied };
    }
    if (typeof currentVersion !== 'string' || currentVersion === '') return state;
    if (state.pending.version !== currentVersion) return state;
    const applied = { version: currentVersion, at: Date.now() };
    if (typeof state.pending.requestedAt === 'number') applied.requestedAt = state.pending.requestedAt;
    this.write({ applied });
    this.logger?.info?.(`[dsh-versions] switch to ${currentVersion} confirmed`);
    return { applied };
  }

  /**
   * 面板/工具要的状态视图（含自动结算）。
   * @param {string|undefined} currentVersion 当前版本。
   * @returns {{pending?: object, applied?: object}} 状态。
   */
  status(currentVersion) {
    return this.settle(currentVersion);
  }

  /**
   * 后台任务的日志尾巴（没有日志时返回空串）。
   * @param {number} [maxLines] 最多几行。
   * @returns {{path: string, exists: boolean, text: string}} 日志。
   */
  log(maxLines = 20) {
    return readLog(this.dir, maxLines);
  }

  /**
   * 请求切换到某个**已下载**的版本：在后台把 DSH 关掉、跑安装程序、再拉起来。
   *
   * @param {string} version 目标版本。
   * @param {string|undefined} currentVersion 当前版本。
   * @returns {Promise<{ok: boolean, code?: string, error?: string, version?: string, path?: string, pid?: number, logPath?: string}>} 结果。
   */
  async request(version, currentVersion) {
    if (version === currentVersion) return { ok: false, code: 'ALREADY_CURRENT' };
    const entry = this.downloader.entryFor(version);
    if (entry === undefined) return { ok: false, code: 'NOT_DOWNLOADED' };
    if (process.platform !== 'win32') {
      // 非 Windows 没有可静默安装的官方安装包，只能把安装程序交给用户。
      return this.requestDirect(version, entry);
    }
    const installDir = this.installDir();
    if (typeof installDir !== 'string' || installDir === '') {
      // 认不出安装目录就**不能**退化成「只启动安装程序」：那条路不关 DSH，
      // 安装程序会因为文件被占用而卡住或失败，用户看到的就是「点了切换没反应」。
      // 宁可报错，也不做假动作。
      this.logger?.warn?.('[dsh-versions] switch aborted: install directory unknown');
      return { ok: false, code: 'NO_INSTALL_DIR', error: '认不出当前 DSH 的安装目录，无法自动切换' };
    }
    const request = buildRequest({
      version,
      installerPath: entry.path,
      installDir,
      exeFile: resolveExeFile(installDir),
      logPath: readLog(this.dir).path,
    });
    const launched = await this.launcher({ dir: this.dir, request, logger: this.logger });
    if (launched.ok !== true) {
      return { ok: false, code: 'LAUNCH_FAILED', error: launched.error ?? '无法启动后台更新任务' };
    }
    const pending = { version, at: Date.now(), path: entry.path, logPath: request.logPath };
    if (Number.isFinite(launched.pid)) pending.pid = launched.pid;
    const previous = this.read();
    this.write({ pending, applied: previous.applied });
    this.logger?.info?.(`[dsh-versions] switch requested: ${version} -> ${installDir} (pid ${launched.pid ?? '?'})`);
    return { ok: true, version, path: entry.path, pid: launched.pid, logPath: request.logPath };
  }

  /**
   * 兜底：只把安装程序拉起来，让用户自己在向导里完成（仅非 Windows）。
   *
   * 这条路**没有后台任务**，DSH 不会被关掉，所以不写 `pending` —— 否则面板会一直
   * 挂着「后台任务正在关闭 DSH」的横幅，而实际上什么都没在跑。
   *
   * @param {string} version 目标版本。
   * @param {{path: string}} entry 已下载的安装包。
   * @returns {{ok: boolean, code?: string, error?: string, version?: string, path?: string, pid?: number}} 结果。
   */
  requestDirect(version, entry) {
    if (typeof this.downloader.launch !== 'function') {
      return { ok: false, code: 'NO_INSTALL_DIR', error: '认不出当前 DSH 的安装目录，无法自动切换' };
    }
    const launched = this.downloader.launch(entry.path);
    if (launched.ok !== true) {
      return { ok: false, code: 'LAUNCH_FAILED', error: launched.error ?? '无法启动安装程序' };
    }
    this.logger?.info?.(`[dsh-versions] switch requested (direct launch): ${version}`);
    return { ok: true, version, path: entry.path, pid: launched.pid };
  }

  /**
   * 取消待切换标记（用户不想切了）。
   *
   * 注意：后台任务一旦开始关 DSH 就拦不住了，这里只能清掉记录。
   *
   * @returns {{ok: boolean, cleared: boolean}} 结果。
   */
  cancel() {
    const state = this.read();
    const cleared = state.pending !== undefined;
    if (cleared) this.write({ applied: state.applied });
    return { ok: true, cleared };
  }
}

/**
 * 已下载安装包的视图（面板与 Agent 工具共用同一份口径）。
 * @param {{downloader: object, switcher?: object, currentVersion?: string}} options 选项。
 * @returns {object} 视图。
 */
export function downloadsView(options) {
  const { downloader, switcher, currentVersion } = options;
  const items = downloader.list().map((row) => ({
    ...row,
    current: row.version === currentVersion,
  }));
  const totalSize = items.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
  const state = switcher === undefined || typeof switcher.status !== 'function'
    ? {}
    : switcher.status(currentVersion);
  return {
    items,
    total: items.length,
    totalSize,
    totalSizeText: formatBytes(totalSize),
    dir: downloader.dir,
    pending: state.pending,
    applied: state.applied,
  };
}

/**
 * 版本切换：把「已下载的安装包」变成一次明确的切换动作。
 *
 * 切换版本的唯一正路还是官方安装程序（见 installer.js 的说明）：插件不替换
 * 文件、不碰 autoUpdater，只负责**启动对应版本的安装程序**，并记下「用户请求
 * 切换到哪个版本」。
 *
 * 为什么还要记一笔？因为安装程序是异步的、需要用户点几下、可能还要先退出
 * DSH。面板下次打开时，光看「已下载」不知道用户到底点没点切换。所以：
 *
 * - 请求切换时写 `pending`（版本 + 时间）；
 * - 下次探测到当前版本 === pending.version，说明切换真的生效了，落成
 *   `applied` 并清掉 pending；
 * - 用户中途反悔（关掉了安装程序），可以在面板上取消这个标记。
 *
 * 状态落在 `<dataDir>/switch-state.json`，走 JsonCache 的「临时文件 + rename」。
 *
 * @module dsh-versions/switch
 */

import { JsonCache } from './cache.js';
import { formatBytes } from './installer.js';

/** 状态缓存名。 */
const NAME = 'switch-state';

/**
 * 把任意值收敛成 `{version, at, ...}` 形态。
 * @param {unknown} value 原始值。
 * @returns {{version: string, at?: number, path?: string, requestedAt?: number}|undefined} 记录。
 */
function normalize(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const version = value.version;
  if (typeof version !== 'string' || version === '') return undefined;
  const result = { version };
  for (const key of ['at', 'requestedAt']) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number > 0) result[key] = number;
  }
  if (typeof value.path === 'string' && value.path !== '') result.path = value.path;
  return result;
}

/**
 * 切换状态的读写与「请求切换」。
 */
export class Switcher {
  /**
   * @param {{downloader: object, dir: string, logger?: object}} options 选项。
   */
  constructor(options) {
    this.downloader = options.downloader;
    this.cache = new JsonCache({ dir: options.dir });
    this.logger = options.logger;
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
   * `applied` 并清掉 pending，之后再调用不会再产生写入。
   *
   * @param {string|undefined} currentVersion 当前运行版本。
   * @returns {{pending?: object, applied?: object}} 结算后的状态。
   */
  settle(currentVersion) {
    const state = this.read();
    if (state.pending === undefined) return state;
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
   * 请求切换到某个**已下载**的版本：启动它的官方安装程序并记下意图。
   * @param {string} version 目标版本。
   * @param {string|undefined} currentVersion 当前版本。
   * @returns {{ok: boolean, code?: string, error?: string, version?: string, path?: string, pid?: number}} 结果。
   */
  request(version, currentVersion) {
    if (version === currentVersion) return { ok: false, code: 'ALREADY_CURRENT' };
    const entry = this.downloader.entryFor(version);
    if (entry === undefined) return { ok: false, code: 'NOT_DOWNLOADED' };
    const launched = this.downloader.launch(entry.path);
    if (launched.ok !== true) {
      return { ok: false, code: 'LAUNCH_FAILED', error: launched.error ?? '无法启动安装程序' };
    }
    const pending = { version, at: Date.now(), path: entry.path };
    const previous = this.read();
    this.write({ pending, applied: previous.applied });
    this.logger?.info?.(`[dsh-versions] switch requested: ${version} (${entry.path})`);
    return { ok: true, version, path: entry.path, pid: launched.pid };
  }

  /**
   * 取消待切换标记（用户关掉了安装程序，或者不想切了）。
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

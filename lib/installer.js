/**
 * 官方安装包的下载与启动。
 *
 * 用户明确说过「也可以不从 npm 下载」，所以这里**不走 npm**：直接拿
 * `download.deepseek.com` 上的官方桌面安装包（和 Electron 自动更新同一个分发
 * 源），下载到本地后用系统默认方式启动它，由官方安装程序完成升级。
 *
 * 这样做的好处：
 * - 和手动双击安装包完全等价，不碰 `settings.json`、不碰运行时目录、不假装
 *   自己是 autoUpdater；
 * - 装的是带签名的官方产物，失败了用户自己还能重来一遍。
 *
 * 代价：安装程序会要求关闭当前 DSH，这是它自己的交互，插件只负责把安装包
 * 下好并递到用户手上。
 *
 * 下载状态只存在内存里（单进程、一次性），面板轮询 `download` 操作取进度。
 *
 * @module dsh-versions/installer
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { compareVersions } from './version.js';

/** 同时只允许一个下载。 */
const SINGLETON = { current: undefined };

/**
 * 把字节数说成人话。
 * @param {number} bytes 字节。
 * @returns {string} 例如 `286.1 MB`。
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const rounded = index === 0 ? String(Math.round(size)) : size.toFixed(1).replace(/\.0$/u, '');
  return `${rounded} ${units[index]}`;
}

/**
 * 从 URL 里取文件名。
 * @param {string} url 直链。
 * @returns {string} 文件名。
 */
export function fileNameOf(url) {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split('/').filter((part) => part !== '').pop();
    return typeof name === 'string' && name !== '' ? name : 'dsh-installer';
  } catch {
    return 'dsh-installer';
  }
}

/**
 * 下载管理器。
 */
export class Downloader {
  /**
   * @param {{dir: string, logger?: object}} options 选项。
   */
  constructor(options) {
    this.dir = options.dir;
    this.logger = options.logger;
  }

  /**
   * 某个版本的安装包落地路径。
   * @param {string} version 版本号。
   * @param {string} url 直链。
   * @returns {string} 路径。
   */
  pathFor(version, url) {
    return join(this.dir, version, fileNameOf(url));
  }

  /**
   * 已下载完成的安装包（存在且大小合理）。
   * @param {string} version 版本号。
   * @param {string} url 直链。
   * @returns {{path: string, size: number}|undefined} 结果。
   */
  downloaded(version, url) {
    const path = this.pathFor(version, url);
    try {
      const size = statSync(path).size;
      return size > 1024 * 1024 ? { path, size } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 当前下载状态（面板轮询用）。
   * @returns {object} 状态。
   */
  status() {
    const current = SINGLETON.current;
    if (current === undefined) return { active: false };
    const elapsed = Date.now() - current.startedAt;
    const speed = elapsed > 0 ? (current.received / elapsed) * 1000 : 0;
    return {
      active: current.state === 'downloading',
      version: current.version,
      state: current.state,
      received: current.received,
      total: current.total,
      percent: current.total > 0 ? Math.min(100, (current.received / current.total) * 100) : undefined,
      speed,
      path: current.path,
      error: current.error,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
    };
  }

  /**
   * 下载一个安装包（同一时刻只允许一个）。
   * @param {{version: string, url: string, expectedSize?: number}} request 请求。
   * @returns {Promise<object>} 结果。
   */
  async start(request) {
    if (SINGLETON.current !== undefined && SINGLETON.current.state === 'downloading') {
      return { ok: false, error: '已有下载任务在进行中' };
    }
    const existing = this.downloaded(request.version, request.url);
    if (existing !== undefined) {
      return { ok: true, version: request.version, path: existing.path, size: existing.size, cached: true };
    }

    const path = this.pathFor(request.version, request.url);
    const temporary = `${path}.part`;
    const job = {
      version: request.version,
      url: request.url,
      path,
      received: 0,
      total: Number.isFinite(request.expectedSize) && request.expectedSize > 0 ? request.expectedSize : 0,
      state: 'downloading',
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
    };
    SINGLETON.current = job;

    try {
      mkdirSync(join(this.dir, request.version), { recursive: true });
      rmSync(temporary, { force: true });
      const response = await fetch(request.url, { headers: { accept: '*/*' } });
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
      if (job.total === 0) {
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > 0) job.total = length;
      }
      if (response.body === null) throw new Error('下载失败：响应没有正文');

      const stream = createWriteStream(temporary);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        job.received += value.byteLength;
        if (stream.write(Buffer.from(value)) === false) {
          await new Promise((resolve) => stream.once('drain', resolve));
        }
      }
      await new Promise((resolve, reject) => {
        stream.end((error) => (error === undefined || error === null ? resolve() : reject(error)));
      });

      const size = statSync(temporary).size;
      if (job.total > 0 && size !== job.total) {
        throw new Error(`下载不完整：期望 ${formatBytes(job.total)}，实际 ${formatBytes(size)}`);
      }
      rmSync(path, { force: true });
      // rename 在同一分区上是原子的，避免半成品被当成已下载。
      renameSync(temporary, path);
      job.state = 'done';
      job.received = size;
      job.total = size;
      job.finishedAt = Date.now();
      return { ok: true, version: request.version, path, size, cached: false };
    } catch (error) {
      job.state = 'failed';
      job.error = String(error?.message ?? error);
      job.finishedAt = Date.now();
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* 清理失败无所谓 */
      }
      this.logger?.warn?.(`[dsh-versions] download ${request.version} failed: ${job.error}`);
      return { ok: false, error: job.error, version: request.version };
    } finally {
      // 状态保留 30 秒给面板读完，之后释放单例锁。
      setTimeout(() => {
        if (SINGLETON.current === job) SINGLETON.current = undefined;
      }, 30_000).unref?.();
    }
  }

  /**
   * 启动已下载的安装包（完全脱离本进程）。
   * @param {string} path 安装包路径。
   * @returns {{ok: boolean, pid?: number, error?: string}} 结果。
   */
  launch(path) {
    if (typeof path !== 'string' || path === '' || !existsSync(path)) {
      return { ok: false, error: '安装包不存在，请先下载' };
    }
    try {
      const child = spawn(path, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: dirname(path),
      });
      child.unref();
      return { ok: true, pid: child.pid };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 删除某个版本的安装包。
   * @param {string} version 版本号。
   * @param {string} url 直链。
   * @returns {boolean} 是否删除。
   */
  remove(version, url) {
    try {
      rmSync(this.pathFor(version, url), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 按版本号找已下载的安装包（不需要知道直链）。
   *
   * 下载目录结构是 `<dir>/<version>/<文件名>`，所以扫目录就够了。历史上同一个
   * 版本可能有多个文件（不同平台的后缀），取最大的那个——它才可能是完整的。
   *
   * @param {string} version 版本号。
   * @returns {{version: string, path: string, size: number, sizeText: string, fileName: string, downloadedAt?: number}|undefined} 条目。
   */
  entryFor(version) {
    if (typeof version !== 'string' || version === '') return undefined;
    const versionDir = join(this.dir, version);
    let files;
    try {
      files = readdirSync(versionDir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    let best;
    for (const file of files) {
      if (file.isFile() !== true || file.name.endsWith('.part')) continue;
      const path = join(versionDir, file.name);
      try {
        const stats = statSync(path);
        if (stats.size <= 1024 * 1024) continue;
        if (best === undefined || stats.size > best.size) {
          best = {
            version,
            path,
            size: stats.size,
            sizeText: formatBytes(stats.size),
            fileName: file.name,
            downloadedAt: stats.mtimeMs,
          };
        }
      } catch {
        /* 读不到就跳过 */
      }
    }
    return best;
  }

  /**
   * 彻底删掉某个版本的下载（整个版本目录，含残留的 `.part`）。
   * @param {string} version 版本号。
   * @returns {{removed: boolean, freedBytes: number}} 结果。
   */
  removeVersion(version) {
    const entry = this.entryFor(version);
    const freed = entry === undefined ? 0 : entry.size;
    try {
      rmSync(join(this.dir, version), { recursive: true, force: true });
      return { removed: true, freedBytes: freed };
    } catch {
      return { removed: false, freedBytes: 0 };
    }
  }

  /**
   * 下载目录里已有的安装包（按版本号目录扫一遍）。
   * @returns {Array<{version: string, path: string, size: number, sizeText: string}>} 列表。
   */
  list() {
    const rows = [];
    let versions;
    try {
      versions = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return rows;
    }
    for (const entry of versions) {
      if (entry.isDirectory() !== true) continue;
      const found = this.entryFor(entry.name);
      if (found === undefined) continue;
      rows.push(found);
    }
    return rows.sort((a, b) => compareVersions(b.version, a.version));
  }
}

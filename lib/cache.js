/**
 * 磁盘 JSON 缓存。
 *
 * 版本目录与更新说明都来自外网（npm registry / GitHub API），前者 400 KB、
 * 后者受 60 次/小时 的匿名限流约束，因此必须落盘：
 *
 * - 新鲜期内直接读盘，不发请求；
 * - 过期后刷新失败时退回旧值（stale-while-error），页面不至于空白；
 * - 写入走「临时文件 + rename」，进程被杀不会留下半个 JSON。
 *
 * @module dsh-versions/cache
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 一个目录下的具名 JSON 缓存。
 */
export class JsonCache {
  /**
   * @param {{dir: string, now?: () => number}} options 选项。
   */
  constructor(options) {
    this.dir = options.dir;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
  }

  /**
   * 某个缓存项的文件路径。
   * @param {string} name 缓存名。
   * @returns {string} 路径。
   */
  fileFor(name) {
    return join(this.dir, `${name}.json`);
  }

  /**
   * 读缓存项（不判断新鲜度）。
   * @param {string} name 缓存名。
   * @returns {{value: unknown, savedAt: number}|undefined} 记录。
   */
  read(name) {
    try {
      const parsed = JSON.parse(readFileSync(this.fileFor(name), 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return undefined;
      const savedAt = Number(parsed.savedAt);
      return {
        value: parsed.value,
        savedAt: Number.isFinite(savedAt) ? savedAt : 0,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 读新鲜缓存项。
   * @param {string} name 缓存名。
   * @param {number} ttlMs 有效期。
   * @returns {{value: unknown, savedAt: number}|undefined} 记录。
   */
  readFresh(name, ttlMs) {
    const record = this.read(name);
    if (record === undefined) return undefined;
    const age = this.now() - record.savedAt;
    if (!Number.isFinite(age) || age < 0 || age > ttlMs) return undefined;
    return record;
  }

  /**
   * 写缓存项。
   * @param {string} name 缓存名。
   * @param {unknown} value 内容（必须可 JSON 序列化）。
   * @returns {boolean} 是否写入成功。
   */
  write(name, value) {
    const file = this.fileFor(name);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(temporary, JSON.stringify({ savedAt: this.now(), value }), 'utf8');
      renameSync(temporary, file);
      return true;
    } catch {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* 临时文件清理失败无所谓 */
      }
      return false;
    }
  }
}

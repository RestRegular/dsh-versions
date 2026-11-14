/**
 * 版本目录：npm 版本清单 + GitHub 更新说明 + 官方安装包可用性。
 *
 * 三个数据源各自独立，合并成面板要的一份目录：
 *
 * 1. **npm registry**（`@deepseek-ai/dsh` 的完整 packument）：权威的版本列表与
 *    发布时间，44 个版本一次拿全。
 * 2. **GitHub releases**（tag 形如 `dsh-v0.2.2-rc.3`）：更新说明正文。只有 39 个
 *    版本发过 release，其余版本面板标注「无更新说明」。
 * 3. **官方下载站**（`download.deepseek.com/dsh-desk/bin/<平台>/`）：桌面版安装包。
 *    只有 win-x64 有产物，而且只从 0.1.7-rc.2 起才有；HEAD 探测结果长期缓存。
 *
 * 全部结果都进磁盘缓存：npm 30 分钟、更新说明 7 天（不可变）、安装包可用性 7 天。
 *
 * @module dsh-versions/catalog
 */

import { JsonCache } from './cache.js';
import { channelOf, compareVersions, installerExtension, isPrerelease, platformDir, tagOf, versionOfTag } from './version.js';

/** 被追踪的 npm 包。 */
export const PACKAGE_NAME = '@deepseek-ai/dsh';

/** 仓库（更新说明来源）。 */
export const REPO = 'deepseek-ai/deepseek-harness';

/** 官方下载站根。 */
export const DOWNLOAD_ROOT = 'https://download.deepseek.com/dsh-desk';

/** 各缓存的名称与有效期。 */
const CACHE = {
  versions: { name: 'npm-versions', ttlMs: 30 * 60 * 1000 },
  releases: { name: 'gh-releases', ttlMs: 30 * 60 * 1000 },
  release: { prefix: 'gh-release-', ttlMs: 7 * 24 * 60 * 60 * 1000 },
  installer: { prefix: 'installer-', ttlMs: 7 * 24 * 60 * 60 * 1000 },
};

/** 单次请求超时。 */
const FETCH_TIMEOUT_MS = 20_000;

/** GitHub 一页最多 100 条，最多翻这么多页。 */
const MAX_RELEASE_PAGES = 3;

/**
 * 带超时的 fetch。
 * @param {string} url 地址。
 * @param {object} [init] 请求参数。
 * @returns {Promise<Response>} 响应。
 */
async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GitHub 请求头。
 * @returns {Record<string, string>} 头。
 */
function githubHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-versions-plugin',
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (typeof token === 'string' && token.trim() !== '') headers.authorization = `Bearer ${token.trim()}`;
  return headers;
}

/**
 * 版本目录。
 */
export class Catalog {
  /**
   * @param {{dir: string, now?: () => number, logger?: object, cacheMinutes?: number}} options 选项。
   */
  constructor(options) {
    this.cache = new JsonCache({ dir: options.dir, now: options.now });
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.logger = options.logger;
    this.platform = process.platform;
    this.arch = process.arch;
    /** 清单类缓存的有效期（毫秒），可由插件配置覆盖。 */
    const minutes = Number(options.cacheMinutes);
    this.ttlMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : CACHE.versions.ttlMs;
    /** 并发探测去重：同一个版本同时只探测一次。 */
    this.probing = new Map();
  }

  /**
   * 当前平台的下载目录名（例如 win-x64）。
   * @returns {string} 目录名。
   */
  platformDir() {
    return platformDir(this.platform, this.arch);
  }

  /**
   * 某个版本的官方安装包直链。
   * @param {string} version 版本号。
   * @returns {string} 直链。
   */
  installerUrl(version) {
    const dir = this.platformDir();
    return `${DOWNLOAD_ROOT}/bin/${dir}/deepseek-harness-${version}-${dir}${installerExtension(this.platform)}`;
  }

  // ------------------------------------------------------------------
  // npm
  // ------------------------------------------------------------------

  /**
   * 读 npm 版本清单（带缓存）。
   * @param {{force?: boolean}} [options] 选项。
   * @returns {Promise<{versions: Array<{version: string, publishedAt?: number}>, tags: Record<string, string>, stale: boolean, error?: string}>} 清单。
   */
  async npmVersions(options = {}) {
    const { name } = CACHE.versions;
    const ttlMs = this.ttlMs;
    if (options.force !== true) {
      const fresh = this.cache.readFresh(name, ttlMs);
      if (fresh !== undefined) return { ...fresh.value, stale: false };
    }
    try {
      const response = await fetchWithTimeout(`https://registry.npmjs.org/${PACKAGE_NAME}`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`);
      const packument = await response.json();
      const time = packument !== null && typeof packument.time === 'object' && packument.time !== null
        ? packument.time
        : {};
      const versions = Object.keys(packument?.versions ?? {})
        .map((version) => {
          const stamp = time[version];
          const publishedAt = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
          return {
            version,
            publishedAt: Number.isFinite(publishedAt) ? publishedAt : undefined,
          };
        })
        .sort((a, b) => compareVersions(b.version, a.version));
      const tags = packument?.['dist-tags'] !== null && typeof packument?.['dist-tags'] === 'object'
        ? { ...packument['dist-tags'] }
        : {};
      const value = { versions, tags };
      this.cache.write(name, value);
      return { ...value, stale: false };
    } catch (error) {
      const stale = this.cache.read(name);
      const message = String(error?.message ?? error);
      this.logger?.warn?.(`[dsh-versions] npm versions failed: ${message}`);
      if (stale !== undefined) return { ...stale.value, stale: true, error: message };
      return { versions: [], tags: {}, stale: true, error: message };
    }
  }

  // ------------------------------------------------------------------
  // GitHub releases
  // ------------------------------------------------------------------

  /**
   * 读 release 列表（带缓存）。
   * @param {{force?: boolean}} [options] 选项。
   * @returns {Promise<{releases: Array<object>, stale: boolean, error?: string}>} 列表。
   */
  async releases(options = {}) {
    const { name } = CACHE.releases;
    const ttlMs = this.ttlMs;
    if (options.force !== true) {
      const fresh = this.cache.readFresh(name, ttlMs);
      if (fresh !== undefined) return { ...fresh.value, stale: false };
    }
    try {
      const collected = [];
      for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
        const response = await fetchWithTimeout(
          `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
          { headers: githubHeaders() },
        );
        if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
        const batch = await response.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const item of batch) {
          const version = versionOfTag(item?.tag_name);
          if (version === undefined) continue;
          collected.push({
            version,
            tag: item.tag_name,
            name: typeof item.name === 'string' ? item.name : undefined,
            url: typeof item.html_url === 'string' ? item.html_url : undefined,
            publishedAt: typeof item.published_at === 'string' ? Date.parse(item.published_at) : undefined,
            prerelease: item.prerelease === true,
            body: typeof item.body === 'string' ? item.body : '',
          });
        }
        if (batch.length < 100) break;
      }
      const value = { releases: collected };
      this.cache.write(name, value);
      return { ...value, stale: false };
    } catch (error) {
      const stale = this.cache.read(name);
      const message = String(error?.message ?? error);
      this.logger?.warn?.(`[dsh-versions] GitHub releases failed: ${message}`);
      if (stale !== undefined) return { ...stale.value, stale: true, error: message };
      return { releases: [], stale: true, error: message };
    }
  }

  /**
   * 单个版本的更新说明。列表里没有该版本时按 tag 精确查一次。
   * @param {string} version 版本号。
   * @param {{force?: boolean}} [options] 选项。
   * @returns {Promise<{version: string, body: string, url?: string, publishedAt?: number, found: boolean, error?: string}>} 说明。
   */
  async releaseBody(version, options = {}) {
    const name = `${CACHE.release.prefix}${version}`;
    if (options.force !== true) {
      const fresh = this.cache.readFresh(name, CACHE.release.ttlMs);
      if (fresh !== undefined) return fresh.value;
    }
    const listed = await this.releases();
    const hit = listed.releases.find((item) => item.version === version);
    if (hit !== undefined) {
      const value = {
        version,
        body: hit.body,
        url: hit.url,
        publishedAt: hit.publishedAt,
        found: true,
      };
      this.cache.write(name, value);
      return value;
    }
    try {
      const response = await fetchWithTimeout(
        `https://api.github.com/repos/${REPO}/releases/tags/${tagOf(version)}`,
        { headers: githubHeaders() },
      );
      if (response.status === 404) {
        const value = { version, body: '', found: false };
        this.cache.write(name, value);
        return value;
      }
      if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
      const item = await response.json();
      const value = {
        version,
        body: typeof item?.body === 'string' ? item.body : '',
        url: typeof item?.html_url === 'string' ? item.html_url : undefined,
        publishedAt: typeof item?.published_at === 'string' ? Date.parse(item.published_at) : undefined,
        found: true,
      };
      this.cache.write(name, value);
      return value;
    } catch (error) {
      const stale = this.cache.read(name);
      const message = String(error?.message ?? error);
      this.logger?.warn?.(`[dsh-versions] release ${version} failed: ${message}`);
      if (stale !== undefined) return { ...stale.value, error: message };
      return { version, body: '', found: false, error: message };
    }
  }

  // ------------------------------------------------------------------
  // 官方安装包
  // ------------------------------------------------------------------

  /**
   * 探测某个版本在当前平台是否有官方安装包。
   * @param {string} version 版本号。
   * @param {{force?: boolean}} [options] 选项。
   * @returns {Promise<{version: string, available: boolean, url: string, size?: number, error?: string}>} 探测结果。
   */
  async installer(version, options = {}) {
    const name = `${CACHE.installer.prefix}${version}`;
    if (options.force !== true) {
      const fresh = this.cache.readFresh(name, CACHE.installer.ttlMs);
      if (fresh !== undefined) return fresh.value;
    }
    const pending = this.probing.get(version);
    if (pending !== undefined) return pending;

    const url = this.installerUrl(version);
    const task = (async () => {
      try {
        const response = await fetchWithTimeout(url, { method: 'HEAD' });
        const length = Number(response.headers.get('content-length'));
        const value = {
          version,
          available: response.ok,
          url,
          size: Number.isFinite(length) && length > 0 ? length : undefined,
          status: response.status,
        };
        this.cache.write(name, value);
        return value;
      } catch (error) {
        const stale = this.cache.read(name);
        const message = String(error?.message ?? error);
        this.logger?.warn?.(`[dsh-versions] installer probe ${version} failed: ${message}`);
        if (stale !== undefined) return { ...stale.value, error: message };
        return { version, available: false, url, error: message };
      } finally {
        this.probing.delete(version);
      }
    })();
    this.probing.set(version, task);
    return task;
  }

  /**
   * 批量探测（并发 6，最多 24 个），用于「检测可安装性」按钮。
   * @param {Array<string>} versions 版本号。
   * @returns {Promise<Array<object>>} 探测结果。
   */
  async probeMany(versions) {
    const queue = versions.slice(0, 24);
    const results = [];
    const workers = [];
    const width = Math.min(6, queue.length);
    for (let index = 0; index < width; index += 1) {
      workers.push((async () => {
        for (;;) {
          const version = queue.shift();
          if (version === undefined) return;
          results.push(await this.installer(version));
        }
      })());
    }
    await Promise.all(workers);
    return results;
  }

  // ------------------------------------------------------------------
  // 合并视图
  // ------------------------------------------------------------------

  /**
   * 面板要的完整目录。
   * @param {{force?: boolean, currentVersion?: string}} [options] 选项。
   * @returns {Promise<object>} 目录。
   */
  async overview(options = {}) {
    const [npm, gh] = await Promise.all([
      this.npmVersions({ force: options.force }),
      this.releases({ force: options.force }),
    ]);
    const byVersion = new Map(gh.releases.map((item) => [item.version, item]));
    const current = typeof options.currentVersion === 'string' ? options.currentVersion : undefined;

    const versions = npm.versions.map((row) => {
      const release = byVersion.get(row.version);
      const cached = this.cache.read(`${CACHE.installer.prefix}${row.version}`);
      const installer = cached === undefined ? undefined : cached.value;
      return {
        version: row.version,
        channel: channelOf(row.version),
        prerelease: isPrerelease(row.version),
        publishedAt: row.publishedAt ?? release?.publishedAt,
        hasChangelog: release !== undefined && release.body !== '',
        releaseUrl: release?.url,
        installer: installer === undefined
          ? 'unknown'
          : installer.available === true ? 'available' : 'missing',
        installerSize: installer?.size,
        current: current !== undefined && row.version === current,
      };
    });

    return {
      packageName: PACKAGE_NAME,
      platform: this.platform,
      arch: this.arch,
      platformDir: this.platformDir(),
      distTags: npm.tags,
      currentVersion: current,
      versions,
      total: versions.length,
      withChangelog: versions.filter((row) => row.hasChangelog).length,
      stale: npm.stale || gh.stale,
      error: npm.error ?? gh.error,
    };
  }
}

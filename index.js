/**
 * dsh-versions — Host half.
 *
 * 职责：给「DSH 版本历史」面板和三个 Agent 工具提供数据。
 *
 * 数据面三件事：
 *
 * 1. **版本清单**：npm registry 上 `@deepseek-ai/dsh` 的完整 packument（44 个版本
 *    与发布时间），落盘缓存 30 分钟。
 * 2. **更新说明**：GitHub releases（tag `dsh-v<version>`）的双语正文，解析成中英
 *    两段；release 列表缓存 30 分钟，单版本正文缓存 7 天（不可变）。
 * 3. **官方安装包**：`download.deepseek.com/dsh-desk/bin/<平台>/` 的 HEAD 探测与
 *    下载。用户明确说过「也可以不从 npm 下载」，所以切换版本走官方安装包这条路：
 *    下载 → 交给用户双击，不碰 autoUpdater、不手改 settings.json。
 *
 * 面板走回环路由 `/dsh-versions/api`（见 lib/routes.js），Agent 工具走
 * `dsh_versions_*`（见 lib/tools.js），两者共用同一份 Catalog / Downloader。
 *
 * @module dsh-versions
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { Catalog } from './lib/catalog.js';
import { Config, normalizeConfig } from './lib/config.js';
import { Downloader } from './lib/installer.js';
import { defaultDataDir } from './lib/paths.js';
import { mountRoutes } from './lib/routes.js';
import { detectCurrentVersion, updateChannel } from './lib/runtime.js';
import { createVersionTools } from './lib/tools.js';
import { compareVersions } from './lib/version.js';

/** 插件名，用于日志前缀。 */
export const name = 'dsh-versions';

export { Config, normalizeConfig, compareVersions };

/**
 * 插件体。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {unknown} [rawConfig] 行配置。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger;
  const dataDir = config.dataDir === '' ? defaultDataDir() : config.dataDir;

  const catalog = new Catalog({ dir: dataDir, logger, cacheMinutes: config.cacheMinutes });
  const downloader = new Downloader({ dir: `${dataDir}/downloads`, logger });

  /** 运行时信息缓存（版本探测会读 asar，别每次请求都读）。 */
  let runtimeCache;
  let runtimeAt = 0;
  const RUNTIME_TTL_MS = 60_000;

  /**
   * 取运行时信息。
   * @param {boolean} [force] 是否强制重新探测。
   * @returns {object} 信息。
   */
  function runtime(force = false) {
    const now = Date.now();
    if (force !== true && runtimeCache !== undefined && now - runtimeAt < RUNTIME_TTL_MS) {
      return runtimeCache;
    }
    const detected = detectCurrentVersion();
    const channel = updateChannel();
    runtimeCache = {
      ...detected,
      platform: process.platform,
      arch: process.arch,
      channel: channel.channel,
      feedUrl: channel.feedUrl,
      downloadDir: `${dataDir}/downloads`,
    };
    runtimeAt = now;
    return runtimeCache;
  }

  const ops = {
    runtime,
    overview: () => catalog.overview({ currentVersion: runtime().version }),
    release: (version) => catalog.releaseBody(version),
    installer: (version) => catalog.installer(version),
    download: async (version) => {
      const probe = await catalog.installer(version);
      if (probe.available !== true) return { ok: false, code: 'NO_INSTALLER' };
      return downloader.start({ version, url: probe.url, expectedSize: probe.size });
    },
  };

  // ------------------------------------------------------------------
  // 1. 面板 API
  // ------------------------------------------------------------------
  ctx.inject(['webServer'], (scoped) => {
    mountRoutes(scoped, { catalog, downloader, runtime, logger });
  });

  // ------------------------------------------------------------------
  // 2. Agent 工具
  // ------------------------------------------------------------------
  ctx.inject(['tools'], (scoped) => {
    try {
      const definitions = createVersionTools(defineTool, ops);
      for (const definition of definitions) {
        scoped.effect(() => scoped.tools.register(definition), `dsh-versions: ${definition.name} tool`);
      }
    } catch (error) {
      logger?.warn?.(`[dsh-versions] tools registration failed: ${error?.message ?? error}`);
    }
  });

  // ------------------------------------------------------------------
  // 3. 运行时上下文：当前版本（原地替换，不涨历史）
  // ------------------------------------------------------------------
  ctx.inject(['systemPrompt'], (scoped) => {
    const systemPrompt = scoped.systemPrompt;
    if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') return;
    try {
      scoped.effect(() => systemPrompt.context({
        name: 'versions:current',
        order: 320,
        interpolate: false,
        text: () => {
          if (!config.promptContext) return '';
          const info = runtime();
          if (typeof info.version !== 'string' || info.version === '') return '';
          const parts = [`当前 DSH 版本：${info.version}`];
          if (info.desktopVersion !== undefined && info.desktopVersion !== info.version) {
            parts.push(`桌面壳版本：${info.desktopVersion}`);
          }
          if (info.channel !== undefined) parts.push(`更新通道：${info.channel}`);
          return [
            parts.join(' · '),
            '用户问版本历史、更新内容或想换版本时，用 dsh_versions_list / dsh_versions_release / dsh_versions_download。',
          ].join('\n');
        },
      }), 'dsh-versions: version context');
    } catch (error) {
      logger?.warn?.(`[dsh-versions] prompt context registration failed: ${error?.message ?? error}`);
    }
  });

  // ------------------------------------------------------------------
  // 4. 空闲预热：插件加载后拉一次清单，面板打开就有数据
  // ------------------------------------------------------------------
  ctx.effect(() => {
    let disposed = false;
    const timer = setTimeout(() => {
      if (disposed) return;
      void catalog.overview({ currentVersion: runtime().version }).catch(() => {
        /* 预热失败无所谓，面板打开时会重试 */
      });
    }, 1200);
    timer.unref?.();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, 'dsh-versions: warmup');
}

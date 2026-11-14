/**
 * dsh-versions — Client half.
 *
 * 一个界面：侧边栏「版本历史」页（`sidebar.panellist` + `main`）。
 *
 * 左边是版本清单（版本号、渠道、发布日期、有没有更新说明、有没有官方安装包），
 * 右边是选中版本的更新说明（中英切换）。切换版本的动作是「下载官方安装包 →
 * 用户自己双击安装」，不碰 autoUpdater、不手改 settings.json。
 *
 * 数据全部来自宿主回环路由 `/dsh-versions/api`（同一套 Catalog 也供 Agent 工具）。
 *
 * - 整个文件包在 IIFE 里：客户端 bundle 被拼进同一个 classic-script 批次执行，
 *   顶层绑定会与其它插件冲突。
 * - 样式只用 `--dsw-alias-*` / `--dsw-specific-*` 主题 token，浅色/深色由宿主继承。
 */
(() => {
  const MODULE_ID = '@restregular/dsh-versions';

  /** 宿主 facade 是否已经登记过本模块（重复加载时直接退出）。 */
  function alreadyRegistered() {
    const factories = window.__ModuleLoader__?.factories;
    return factories !== undefined && typeof factories.has === 'function' && factories.has(MODULE_ID);
  }

  if (alreadyRegistered()) return;

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: (require) => {
      const React = require('react');
      const h = React.createElement;
      const { useCallback, useEffect, useMemo, useRef, useState } = React;

      const NS = 'dsh-versions';
      const API = '/dsh-versions/api';
      const PANEL_ID = 'versions';
      /** 下载进度轮询间隔。 */
      const PROGRESS_MS = 900;
      /** 没有下载在跑时的低频心跳（用来发现别的窗口/Agent 工具发起的下载）。 */
      const IDLE_PROGRESS_MS = 3_000;
      /** 「删除」二次确认几秒内没再点就自动收回。 */
      const PURGE_CONFIRM_MS = 4_000;
      /** toast 默认停留时长。 */
      const TOAST_MS = 3_200;
      /** 错误 toast 停留更久一点，够看清原因。 */
      const TOAST_ERROR_MS = 6_500;
      /** 重要提示（例如开始切换版本）停留更久。 */
      const TOAST_LONG_MS = 8_500;

      // ------------------------------------------------------------------
      // 文案
      // ------------------------------------------------------------------
      const DICT = {
        zh: {
          'panel.title': '版本历史',
          'panel.subtitle': 'DSH 每个版本改了什么，以及怎么装回去',
          'panel.current': '当前版本',
          'panel.unknown': '未知',
          'panel.refresh': '刷新',
          'panel.refreshing': '刷新中…',
          'panel.filter.all': '全部',
          'panel.filter.stable': '正式版',
          'panel.filter.rc': 'RC',
          'panel.filter.alpha': 'Alpha',
          'panel.filter.beta': 'Beta',
          'panel.probe': '探测安装包',
          'panel.probing': '探测中…',
          'panel.count': '{shown} / {total} 个版本',
          'panel.loading': '正在读取版本清单…',
          'panel.empty': '没有匹配的版本',
          'panel.error': '读取失败：{message}',
          'panel.retry': '重试',
          'panel.stale': '当前显示的是缓存数据，联网刷新失败',
          'panel.platform': '平台 {platform}',
          'list.current': '当前',
          'list.noChangelog': '无更新说明',
          'list.installer.available': '可下载',
          'list.installer.missing': '无安装包',
          'list.installer.unknown': '未探测',
          'detail.title': '更新说明',
          'detail.pick': '从左边选一个版本看它的更新说明',
          'detail.loading': '正在读取更新说明…',
          'detail.none': '这个版本没有公开的更新说明。',
          'detail.noneHint': '它发布到了 npm，但没有对应的 GitHub release。',
          'detail.compare': '查看完整对比',
          'detail.release': '在 GitHub 上查看',
          'detail.published': '发布于 {date}',
          'detail.emptySection': '（这一节没有条目）',
          'action.download': '下载安装包',
          'action.downloading': '下载中 {percent}',
          'action.downloaded': '重新下载',
          'action.discard': '删除安装包',
          'action.probe': '检查是否有安装包',
          'action.probing': '检查中…',
          'action.downloadedAt': '已下载 {size}',
          'action.noInstaller': '这个版本在 {platform} 上没有官方安装包',
          'action.noInstallerHint': '只有较新的版本提供桌面安装包；更早的版本只能用 npm 安装。',
          'action.installHint': '安装程序会自己完成升级，请按它的提示操作（可能需要先退出 DSH）。',
          'action.discarded': '安装包已删除',
          'action.downloadFailed': '下载失败：{message}',
          'action.switch': '切换到此版本',
          'action.switching': '正在启动后台更新…',
          'action.switched': '已开始切换到 {version}：后台任务会关闭 DSH、静默安装并自动重新打开（界面会短暂断开）',
          'action.switchFailed': '切换失败：{message}',
          'action.switchSame': '这就是当前运行的版本',
          'action.purge': '删除下载',
          'action.purged': '已删除 {version} 的安装包，释放 {size}',
          'action.purgeConfirm': '再点一次确认删除 {version}',
          'action.purgeConfirmHint': '再点一次确认删除 {version}，{seconds} 秒后自动取消',
          'action.purgeCancelled': '已取消删除',
          'action.cancelSwitch': '取消切换',
          'action.switchCancelled': '已取消待切换标记',
          'switch.pending': '待切换：{version} — 后台任务正在关闭 DSH 并静默安装，装完会自动重新打开',
          'switch.log': '切换日志：{path}',
          'switch.applied': '上次切换已完成：{version}（{date}）',
          'download.preparing': '准备下载…',
          'download.speed': '{received} / {total} · {speed}',
          'download.progressTitle': '正在下载 {version}',
          'download.progressTitleUnknown': '正在下载安装包',
          'download.done': '安装包下载完成，可以切换了',
          'toast.dismiss': '关闭提示',
          'action.downloadBusy': '有下载任务在进行中',
          'lang.zh': '中文',
          'lang.en': 'English',
          'downloads.title': '已下载',
          'downloads.count': '{count} 个 · {size}',
          'downloads.empty': '还没有下载过安装包',
          'downloads.emptyHint': '在右边选一个版本点「下载安装包」，下好后会出现在这里，可以随时切换回去。',
          'downloads.dir': '下载目录',
          'downloads.current': '当前',
          'downloads.switch': '切换',
          'downloads.remove': '删除',
          'downloads.total': '共 {count} 个 · {size}',
          'tab.versions': '版本',
          'tab.downloads': '已下载',
        },
        en: {
          'panel.title': 'Version history',
          'panel.subtitle': 'What changed in each DSH release, and how to go back',
          'panel.current': 'Current version',
          'panel.unknown': 'unknown',
          'panel.refresh': 'Refresh',
          'panel.refreshing': 'Refreshing…',
          'panel.filter.all': 'All',
          'panel.filter.stable': 'Stable',
          'panel.filter.rc': 'RC',
          'panel.filter.alpha': 'Alpha',
          'panel.filter.beta': 'Beta',
          'panel.probe': 'Check installers',
          'panel.probing': 'Checking…',
          'panel.count': '{shown} / {total} versions',
          'panel.loading': 'Loading version list…',
          'panel.empty': 'No matching versions',
          'panel.error': 'Failed to load: {message}',
          'panel.retry': 'Retry',
          'panel.stale': 'Showing cached data; the online refresh failed',
          'panel.platform': 'Platform {platform}',
          'list.current': 'current',
          'list.noChangelog': 'no notes',
          'list.installer.available': 'installer',
          'list.installer.missing': 'no installer',
          'list.installer.unknown': 'unchecked',
          'detail.title': 'Release notes',
          'detail.pick': 'Pick a version on the left to read its release notes',
          'detail.loading': 'Loading release notes…',
          'detail.none': 'This version has no public release notes.',
          'detail.noneHint': 'It was published to npm but has no matching GitHub release.',
          'detail.compare': 'Full changelog',
          'detail.release': 'View on GitHub',
          'detail.published': 'Published {date}',
          'detail.emptySection': '(no items in this section)',
          'action.download': 'Download installer',
          'action.downloading': 'Downloading {percent}',
          'action.downloaded': 'Download again',
          'action.discard': 'Delete installer',
          'action.probe': 'Check for installer',
          'action.probing': 'Checking…',
          'action.downloadedAt': 'Downloaded {size}',
          'action.noInstaller': 'No official installer for this version on {platform}',
          'action.noInstallerHint': 'Only newer versions ship desktop installers; older ones are npm-only.',
          'action.installHint': 'The installer upgrades DSH itself — follow its prompts (it may ask you to quit DSH first).',
          'action.discarded': 'Installer deleted',
          'action.downloadFailed': 'Download failed: {message}',
          'action.switch': 'Switch to this version',
          'action.switching': 'Starting background update…',
          'action.switched': 'Switching to {version}: a background task closes DSH, installs silently and reopens it (the UI drops for a moment)',
          'action.switchFailed': 'Switch failed: {message}',
          'action.switchSame': 'This is the version you are running',
          'action.purge': 'Delete download',
          'action.purged': 'Deleted the {version} installer, freed {size}',
          'action.purgeConfirm': 'Click again to delete {version}',
          'action.purgeConfirmHint': 'Click again to delete {version}; cancelling in {seconds}s',
          'action.purgeCancelled': 'Delete cancelled',
          'action.cancelSwitch': 'Cancel switch',
          'action.switchCancelled': 'Pending switch cleared',
          'switch.pending': 'Pending switch: {version} — a background task is closing DSH, installing silently, then reopening it',
          'switch.log': 'Switch log: {path}',
          'switch.applied': 'Last switch completed: {version} ({date})',
          'download.preparing': 'Preparing download…',
          'download.speed': '{received} / {total} · {speed}',
          'download.progressTitle': 'Downloading {version}',
          'download.progressTitleUnknown': 'Downloading installer',
          'download.done': 'Installer downloaded — ready to switch',
          'toast.dismiss': 'Dismiss',
          'action.downloadBusy': 'A download is already running',
          'lang.zh': '中文',
          'lang.en': 'English',
          'downloads.title': 'Downloaded',
          'downloads.count': '{count} · {size}',
          'downloads.empty': 'No installers downloaded yet',
          'downloads.emptyHint': 'Pick a version on the right and hit "Download installer"; it shows up here so you can switch back anytime.',
          'downloads.dir': 'Download folder',
          'downloads.current': 'current',
          'downloads.switch': 'Switch',
          'downloads.remove': 'Delete',
          'downloads.total': '{count} downloaded · {size}',
          'tab.versions': 'Versions',
          'tab.downloads': 'Downloaded',
        },
      };

      /**
       * 字典兜底翻译（locale 服务缺失时也能显示中文）。
       * @param key - 词条。
       * @param params - 占位符。
       * @returns {string} 文本。
       */
      function fallbackTranslate(key, params) {
        const dict = DICT.zh;
        let text = dict[key] !== undefined ? dict[key] : key;
        for (const [name, value] of Object.entries(params || {})) {
          text = text.split(`{${name}}`).join(String(value));
        }
        return text;
      }

      let translateCurrent = fallbackTranslate;

      /**
       * 绑定宿主 locale 服务。
       * @param ctx - 客户端上下文。
       * @returns {void}
       */
      function bindLocale(ctx) {
        const locale = ctx.get('locale');
        if (locale === undefined || typeof locale.register !== 'function') return;
        try {
          const dispose = locale.register(NS, DICT);
          if (typeof locale.bind === 'function') translateCurrent = locale.bind(NS);
          ctx.effect(() => () => {
            translateCurrent = fallbackTranslate;
            try {
              dispose?.();
            } catch {
              /* 移除字典失败不应影响卸载 */
            }
          }, 'dsh-versions: dictionaries');
        } catch (error) {
          console.warn('[dsh-versions] locale registration failed:', error?.message ?? error);
        }
      }

      // ------------------------------------------------------------------
      // 宿主路由
      // ------------------------------------------------------------------
      async function apiGet(op, params = {}) {
        const url = new URL(API, window.location.origin);
        url.searchParams.set('op', op);
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
        const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
        const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
        if (payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload;
      }

      async function apiPost(body) {
        const response = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
        if (payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload;
      }

      // ------------------------------------------------------------------
      // 格式化
      // ------------------------------------------------------------------
      function formatDate(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
        try {
          const date = new Date(value);
          const pad = (n) => String(n).padStart(2, '0');
          return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        } catch {
          return '—';
        }
      }

      function formatSize(bytes) {
        const value = Number(bytes);
        if (!Number.isFinite(value) || value <= 0) return '—';
        const units = ['B', 'KB', 'MB', 'GB'];
        let index = 0;
        let size = value;
        while (size >= 1024 && index < units.length - 1) {
          size /= 1024;
          index += 1;
        }
        return `${index === 0 ? Math.round(size) : size.toFixed(1).replace(/\.0$/u, '')} ${units[index]}`;
      }

      /**
       * 渠道标签。
       * @param channel - 渠道。
       * @returns {string} 标签。
       */
      function channelLabel(channel) {
        if (channel === 'stable') return translateCurrent('panel.filter.stable');
        if (channel === 'rc') return 'RC';
        if (channel === 'alpha') return 'Alpha';
        if (channel === 'beta') return 'Beta';
        return channel;
      }

      // ------------------------------------------------------------------
      // 图标
      // ------------------------------------------------------------------
      function VersionsIcon({ size = 16 }) {
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          'aria-hidden': 'true', focusable: 'false',
        },
        h('circle', { cx: 8, cy: 3.3, r: 1.55, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 8, cy: 12.7, r: 1.55, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 8, cy: 8, r: 1.55, fill: 'currentColor', opacity: 0.85 }),
        h('path', { d: 'M8 4.85v1.6M8 9.55v1.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        );
      }

      function RefreshIcon({ size = 14 }) {
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          'aria-hidden': 'true', focusable: 'false',
        },
        h('path', {
          d: 'M13.2 8a5.2 5.2 0 1 1-1.5-3.65',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
        h('path', { d: 'M13.4 1.9v3.2h-3.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        );
      }

      function DownloadIcon({ size = 14 }) {
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          'aria-hidden': 'true', focusable: 'false',
        },
        h('path', { d: 'M8 2.2v7.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M4.9 6.7 8 9.8l3.1-3.1', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M2.8 12.4h10.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        );
      }

      // ------------------------------------------------------------------
      // 样式
      // ------------------------------------------------------------------
      const CSS = `
.dv-root {
  display: flex; flex-direction: column; gap: 12px;
  height: 100%; min-height: 0; padding: 16px 18px 14px;
  color: var(--dsw-alias-label-primary); font-size: 13px;
  box-sizing: border-box;
}
.dv-head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.dv-head-main { min-width: 0; flex: 1 1 auto; }
.dv-title { font-size: 15px; font-weight: 600; letter-spacing: .01em; }
.dv-sub { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dv-current {
  display: flex; align-items: center; gap: 6px; flex: 0 0 auto;
  padding: 5px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px;
}
.dv-current-label { color: var(--dsw-alias-label-secondary); }
.dv-current-value { font-weight: 600; font-variant-numeric: tabular-nums; }
.dv-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dv-chips { display: flex; gap: 4px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.dv-chip {
  appearance: none; border: 0; cursor: pointer; font: inherit; font-size: 12px;
  padding: 4px 9px; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary); transition: background .12s, color .12s;
}
.dv-chip:hover { color: var(--dsw-alias-label-primary); }
.dv-chip[data-active="true"] { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-weight: 600; }
.dv-btn {
  appearance: none; cursor: pointer; font: inherit; font-size: 12px;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 10px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  transition: border-color .12s, background .12s;
}
.dv-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dv-btn:disabled { opacity: .55; cursor: default; }
.dv-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; font-weight: 600; }
.dv-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); opacity: .92; }
.dv-btn-ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.dv-btn-ghost:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dv-spacer { flex: 1 1 auto; }
.dv-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dv-banner {
  padding: 8px 10px; border-radius: 8px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
}
.dv-banner-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dv-banner-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.dv-banner-ok { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.dv-pending { display: flex; align-items: center; gap: 10px; justify-content: space-between; flex-wrap: wrap; }
.dv-tabs { flex: 0 0 auto; }
.dv-tab-count {
  margin-left: 4px; padding: 0 5px; border-radius: 999px; font-size: 10px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
}
.dv-body-single { align-items: stretch; }
.dv-btn-danger {
  background: var(--dsw-alias-state-error-primary); border-color: transparent; color: #fff; font-weight: 600;
}
.dv-btn-danger:hover:not(:disabled) { opacity: .92; background: var(--dsw-alias-state-error-primary); }
.dv-downloads { gap: 8px; }
.dv-dl-list { display: flex; flex-direction: column; gap: 6px; }
.dv-dl-row {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
}
.dv-dl-main { min-width: 0; flex: 1 1 240px; display: flex; flex-direction: column; gap: 3px; }
.dv-dl-top { display: flex; align-items: baseline; gap: 8px; }
.dv-dl-path {
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dv-dl-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; flex-wrap: wrap; }
.dv-dl-dir { margin-top: 2px; word-break: break-all; }
.dv-body { display: flex; gap: 12px; flex: 1 1 auto; min-height: 0; }
.dv-list {
  flex: 0 0 320px; min-width: 0; display: flex; flex-direction: column; gap: 4px;
  overflow-y: auto; padding: 4px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
}
.dv-row {
  appearance: none; cursor: pointer; font: inherit; text-align: left; width: 100%;
  display: flex; flex-direction: column; gap: 3px;
  padding: 7px 9px; border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: inherit;
}
.dv-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dv-row[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dv-row-top { display: flex; align-items: center; gap: 6px; }
.dv-version { font-weight: 600; font-variant-numeric: tabular-nums; font-size: 13px; }
.dv-tag {
  font-size: 10px; line-height: 1.5; padding: 0 5px; border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary);
}
.dv-tag-current { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dv-tag-installer { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.dv-tag-missing { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); opacity: .8; }
.dv-row-bottom { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dv-dot { opacity: .45; }
.dv-detail {
  flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 10px;
  overflow-y: auto; padding: 12px 14px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
}
.dv-detail-head { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
.dv-detail-version { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dv-detail-sub { margin-top: 3px; font-size: 12px; color: var(--dsw-alias-label-secondary); display: flex; gap: 8px; flex-wrap: wrap; }
.dv-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.dv-langs { display: flex; gap: 2px; padding: 2px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.dv-progress { display: flex; flex-direction: column; gap: 5px; }
.dv-progress-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dv-progress-fill { height: 100%; border-radius: 2px; background: var(--dsw-alias-brand-primary); transition: width .25s; }
.dv-progress-fill-indeterminate { width: 40% !important; animation: dv-slide 1.1s ease-in-out infinite; }
@keyframes dv-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
/* 全局下载进度：不跟当前选中版本绑定，切视图/换版本都还在。 */
.dv-dl-global {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
}
.dv-dl-global-main { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.dv-dl-global-title { font-size: 12px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dv-dl-global-version { font-weight: 600; font-variant-numeric: tabular-nums; }
.dv-dl-global-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dv-dl-global[data-state="failed"] { border-color: var(--dsw-alias-state-error-primary); }
/* toast */
.dv-toasts {
  position: fixed; right: 20px; bottom: 20px; z-index: 60;
  display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
  pointer-events: none; max-width: min(420px, calc(100vw - 40px));
}
.dv-toast {
  pointer-events: auto; display: flex; align-items: flex-start; gap: 8px;
  padding: 9px 11px; border-radius: 9px; font-size: 12px; line-height: 1.55;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 6px 20px rgb(0 0 0 / 12%);
  animation: dv-toast-in .16s ease-out;
}
.dv-toast-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dv-toast-warn { border-color: var(--dsw-alias-state-warn-primary); }
.dv-toast-ok { border-color: var(--dsw-alias-state-success-primary); }
.dv-toast-text { min-width: 0; word-break: break-word; }
.dv-toast-close {
  appearance: none; border: 0; background: transparent; cursor: pointer; font: inherit;
  flex: 0 0 auto; padding: 0 2px; line-height: 1.2; opacity: .55;
  color: inherit;
}
.dv-toast-close:hover { opacity: 1; }
@keyframes dv-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.dv-section { display: flex; flex-direction: column; gap: 5px; }
.dv-section-title {
  font-size: 12px; font-weight: 600; letter-spacing: .02em;
  color: var(--dsw-alias-label-secondary); text-transform: uppercase;
}
.dv-items { display: flex; flex-direction: column; gap: 4px; }
.dv-item { display: flex; gap: 7px; line-height: 1.62; font-size: 13px; }
.dv-item-dot { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); opacity: .7; }
.dv-item-text { min-width: 0; word-break: break-word; }
.dv-authors { margin-left: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dv-placeholder {
  flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; padding: 32px 16px; text-align: center; font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}
.dv-placeholder-hint { font-size: 12px; opacity: .8; }
.dv-links { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; }
.dv-link { color: var(--dsw-alias-brand-primary); text-decoration: none; cursor: pointer; }
.dv-link:hover { text-decoration: underline; }
.dv-foot { font-size: 11px; color: var(--dsw-alias-label-secondary); display: flex; gap: 10px; flex-wrap: wrap; }
@media (max-width: 880px) {
  .dv-body { flex-direction: column; }
  .dv-list { flex: 0 0 auto; max-height: 40vh; }
}
`;

      /**
       * 注入样式（卸载时移除）。
       * @param ctx - 客户端上下文。
       * @returns {void}
       */
      function installStyles(ctx) {
        try {
          ctx.effect(() => {
            const style = document.createElement('style');
            style.dataset.dshPlugin = 'dsh-versions';
            style.textContent = CSS;
            document.head.appendChild(style);
            return () => {
              style.remove();
            };
          }, 'dsh-versions: styles');
        } catch (error) {
          console.warn('[dsh-versions] style installation failed:', error?.message ?? error);
        }
      }

      // ------------------------------------------------------------------
      // 组件：版本行
      // ------------------------------------------------------------------
      function VersionRow({ row, selected, onSelect }) {
        const t = translateCurrent;
        const tags = [];
        if (row.current === true) tags.push(h('span', { key: 'cur', className: 'dv-tag dv-tag-current' }, t('list.current')));
        if (row.channel !== 'stable') tags.push(h('span', { key: 'ch', className: 'dv-tag' }, channelLabel(row.channel)));
        if (row.installer === 'available') {
          tags.push(h('span', { key: 'ins', className: 'dv-tag dv-tag-installer' }, t('list.installer.available')));
        } else if (row.installer === 'missing') {
          tags.push(h('span', { key: 'ins', className: 'dv-tag dv-tag-missing' }, t('list.installer.missing')));
        }

        return h('button', {
          type: 'button',
          className: 'dv-row',
          'data-selected': selected === true ? 'true' : 'false',
          onClick: () => onSelect(row.version),
          title: row.version,
        },
        h('div', { className: 'dv-row-top' },
          h('span', { className: 'dv-version' }, row.version),
          ...tags,
        ),
        h('div', { className: 'dv-row-bottom' },
          h('span', null, formatDate(row.publishedAt)),
          h('span', { className: 'dv-dot' }, '·'),
          h('span', null, row.hasChangelog ? t('detail.title') : t('list.noChangelog')),
          row.installerSize !== undefined && row.installer === 'available'
            ? h('span', { className: 'dv-dot' }, '·')
            : null,
          row.installerSize !== undefined && row.installer === 'available'
            ? h('span', null, formatSize(row.installerSize))
            : null,
        ),
        );
      }

      // ------------------------------------------------------------------
      // 组件：更新说明
      // ------------------------------------------------------------------
      function ChangelogBody({ sections, language }) {
        const t = translateCurrent;
        if (!Array.isArray(sections) || sections.length === 0) {
          return h('div', { className: 'dv-meta' }, t('detail.none'));
        }
        const rendered = sections.map((section, index) => {
          const items = section.items.length === 0
            ? [h('div', { key: 'empty', className: 'dv-meta' }, t('detail.emptySection'))]
            : section.items.map((item, itemIndex) => {
              const authors = item.authors !== undefined && item.authors.length > 0
                ? h('span', { className: 'dv-authors' }, `@${item.authors.join(' @')}`)
                : null;
              return h('div', {
                key: `${itemIndex}-${item.text.slice(0, 12)}`,
                className: 'dv-item',
              },
              h('span', { className: 'dv-item-dot' }, '•'),
              h('span', { className: 'dv-item-text' }, item.text, authors),
              );
            });
          return h('div', {
            key: `${language}-${index}-${section.title}`,
            className: 'dv-section',
          },
          section.title !== '' ? h('div', { className: 'dv-section-title' }, section.title) : null,
          h('div', { className: 'dv-items' }, ...items),
          );
        });
        return h(React.Fragment, null, ...rendered);
      }

      // ------------------------------------------------------------------
      // 组件：已下载列表
      // ------------------------------------------------------------------
      function DownloadsList({ view, currentVersion, onSwitch, onPurge, onCancelSwitch, switchBusy, purgeArm, purgeLeft }) {
        const t = translateCurrent;
        const items = Array.isArray(view?.items) ? view.items : [];
        const rows = [];

        if (view?.pending !== undefined) {
          rows.push(h('div', { key: 'pending', className: 'dv-banner dv-banner-warn dv-pending' },
            h('span', null, t('switch.pending', { version: view.pending.version })),
            view.pending.logPath === undefined ? null : h('div', { className: 'dv-meta dv-dl-path', title: view.pending.logPath },
              t('switch.log', { path: view.pending.logPath })),
            h('button', {
              type: 'button',
              className: 'dv-btn dv-btn-ghost',
              onClick: () => { void onCancelSwitch(); },
            }, t('action.cancelSwitch')),
          ));
        }
        if (view?.applied !== undefined) {
          rows.push(h('div', { key: 'applied', className: 'dv-banner dv-banner-ok' },
            t('switch.applied', { version: view.applied.version, date: formatDate(view.applied.at) })));
        }

        if (items.length === 0) {
          rows.push(h('div', { key: 'empty', className: 'dv-placeholder' },
            h('div', null, t('downloads.empty')),
            h('div', { className: 'dv-placeholder-hint' }, t('downloads.emptyHint')),
          ));
        } else {
          rows.push(h('div', { key: 'rows', className: 'dv-dl-list' }, ...items.map((item) => {
            const isCurrent = item.current === true || item.version === currentVersion;
            const actions = [];
            if (isCurrent) {
              actions.push(h('span', { key: 'cur', className: 'dv-tag dv-tag-current' }, t('downloads.current')));
            } else {
              actions.push(h('button', {
                key: 'switch',
                type: 'button',
                className: 'dv-btn dv-btn-primary',
                onClick: () => { void onSwitch(item.version); },
                disabled: switchBusy !== undefined,
              }, switchBusy === item.version ? t('action.switching') : t('downloads.switch')));
            }
            actions.push(h('button', {
              key: 'purge',
              type: 'button',
              className: purgeArm === item.version ? 'dv-btn dv-btn-danger' : 'dv-btn dv-btn-ghost',
              onClick: () => { void onPurge(item.version); },
              title: t('action.purge'),
            }, purgeArm === item.version
              ? t('action.purgeConfirmHint', { version: item.version, seconds: purgeLeft ?? Math.round(PURGE_CONFIRM_MS / 1000) })
              : t('downloads.remove')));

            return h('div', { key: item.version, className: 'dv-dl-row' },
              h('div', { className: 'dv-dl-main' },
                h('div', { className: 'dv-dl-top' },
                  h('span', { className: 'dv-version' }, item.version),
                  h('span', { className: 'dv-meta' }, item.sizeText ?? formatSize(item.size)),
                ),
                h('div', { className: 'dv-dl-path', title: item.path }, item.path),
              ),
              h('div', { className: 'dv-dl-actions' }, ...actions),
            );
          })));
        }

        return h('div', { className: 'dv-detail dv-downloads' },
          h('div', { className: 'dv-detail-head' },
            h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
              h('div', { className: 'dv-detail-version' }, t('downloads.title')),
              h('div', { className: 'dv-detail-sub' },
                h('span', null, t('downloads.total', {
                  count: view?.total ?? items.length,
                  size: view?.totalSizeText ?? formatSize(view?.totalSize),
                })),
              ),
            ),
          ),
          ...rows,
          view?.dir === undefined
            ? null
            : h('div', { className: 'dv-meta dv-dl-dir' }, `${t('downloads.dir')}：${view.dir}`),
        );
      }

      // ------------------------------------------------------------------
      // 组件：面板主体
      // ------------------------------------------------------------------
      function VersionsPage() {
        const t = translateCurrent;
        const [data, setData] = useState(undefined);
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState(undefined);
        const [channel, setChannel] = useState('all');
        const [selected, setSelected] = useState(undefined);
        const [release, setRelease] = useState(undefined);
        const [releaseLoading, setReleaseLoading] = useState(false);
        const [language, setLanguage] = useState('zh');
        const [probing, setProbing] = useState(false);
        const [busy, setBusy] = useState(undefined);
        const [downloaded, setDownloaded] = useState({});
        const [progress, setProgress] = useState(undefined);
        // 这个位置以前是 notice（顶部横幅）。现在放 toast 队列；旧快照注入的
        // undefined 按空数组处理，保证 hook 顺序与既有测试不变。
        const [toasts, setToasts] = useState([]);
        // 追加在最后，保持前面 hook 顺序不变（冒烟测试按位置注入快照）。
        const [view, setView] = useState('versions');
        const [downloads, setDownloads] = useState(undefined);
        const [switchBusy, setSwitchBusy] = useState(undefined);
        const [purgeArm, setPurgeArm] = useState(undefined);
        const [purgeLeft, setPurgeLeft] = useState(0);
        const alive = useRef(true);
        const toastSeq = useRef(0);
        const toastTimers = useRef(new Map());
        /** 已经提示过「下载完成」的版本，避免轮询和发起方各弹一条。 */
        const doneNotified = useRef(undefined);

        useEffect(() => () => {
          alive.current = false;
          for (const timer of toastTimers.current.values()) clearTimeout(timer);
          toastTimers.current.clear();
        }, []);

        /**
         * 弹一条 toast（几秒后自己消失，也可以点掉）。
         * @param {'info'|'error'|'ok'|'warn'} kind 类型。
         * @param {string} text 文案。
         * @param {number} [ms] 停留时长。
         * @returns {void}
         */
        const pushToast = useCallback((kind, text, ms) => {
          toastSeq.current += 1;
          const id = toastSeq.current;
          const ttl = typeof ms === 'number'
            ? ms
            : kind === 'error' ? TOAST_ERROR_MS : TOAST_MS;
          setToasts((previous) => {
            const list = Array.isArray(previous) ? previous : [];
            return [...list, { id, kind, text }].slice(-4);
          });
          const timer = setTimeout(() => {
            setToasts((previous) => (Array.isArray(previous) ? previous.filter((item) => item.id !== id) : []));
            toastTimers.current.delete(id);
          }, ttl);
          timer?.unref?.();
          toastTimers.current.set(id, timer);
        }, []);

        const dismissToast = useCallback((id) => {
          const timer = toastTimers.current.get(id);
          if (timer !== undefined) {
            clearTimeout(timer);
            toastTimers.current.delete(id);
          }
          setToasts((previous) => (Array.isArray(previous) ? previous.filter((item) => item.id !== id) : []));
        }, []);

        const toastList = Array.isArray(toasts) ? toasts : [];

        const load = useCallback(async (force) => {
          setLoading(true);
          setError(undefined);
          try {
            const payload = await apiGet('overview', force === true ? { force: '1' } : {});
            if (!alive.current) return;
            setData(payload);
            const current = payload.runtime?.version;
            if (typeof current === 'string' && current !== '') {
              // 第一次拿到清单时默认选中当前版本；之后保留用户的选择。
              setSelected((previous) => (previous === undefined ? current : previous));
            }
          } catch (caught) {
            if (alive.current) setError(String(caught?.message ?? caught));
          } finally {
            if (alive.current) setLoading(false);
          }
        }, []);

        useEffect(() => {
          void load(false);
          // 只在挂载时拉一次；刷新按钮与下载完成后再拉。
        }, [load]);

        /**
         * 拉已下载清单（含切换状态）。静默失败：不影响版本列表。
         * @returns {Promise<object|undefined>} 视图。
         */
        const loadDownloads = useCallback(async () => {
          try {
            const payload = await apiGet('downloads');
            if (alive.current) setDownloads(payload);
            return payload;
          } catch {
            return undefined;
          }
        }, []);

        useEffect(() => {
          void loadDownloads();
        }, [loadDownloads]);

        // 选中的版本变了：拉它的更新说明。
        useEffect(() => {
          if (typeof selected !== 'string' || selected === '') {
            setRelease(undefined);
            return undefined;
          }
          let cancelled = false;
          setReleaseLoading(true);
          setRelease(undefined);
          apiGet('release', { version: selected })
            .then((payload) => {
              if (!cancelled) setRelease(payload);
            })
            .catch((caught) => {
              if (!cancelled) setRelease({ ok: false, found: false, error: String(caught?.message ?? caught) });
            })
            .finally(() => {
              if (!cancelled) setReleaseLoading(false);
            });
          return () => {
            cancelled = true;
          };
        }, [selected]);

        // 下载进度是宿主侧的全局状态，不是「这个面板此刻的忙」：换版本、切视图、
        // 甚至关掉面板再回来，下载都还在跑，所以这里按宿主回报的 active 决定节奏，
        // 而不是只依赖本地 busy。
        useEffect(() => {
          let cancelled = false;
          let timer;
          let wasActive;
          const tick = async () => {
            let payload;
            try {
              payload = await apiGet('progress');
            } catch {
              payload = undefined;
            }
            if (cancelled) return;
            let running = busy !== undefined;
            if (payload !== undefined) {
              setProgress(payload);
              const active = payload.active === true;
              // 刚跑完：刷新已下载清单；若是别处（另一个窗口 / Agent 工具）发起的
              // 下载，本地 busy 一直是空的，就补一条 toast 告诉用户下好了。
              if (wasActive === true && active !== true) {
                void loadDownloads();
                // 只有「别处发起」的下载（本地 busy 为空）才在这里补提示，
                // 本地发起的由 onDownload 自己报，别弹两条。
                const finished = payload.version ?? busy;
                if (busy === undefined && payload.state === 'done' && finished !== doneNotified.current) {
                  doneNotified.current = finished;
                  pushToast('ok', t('download.done'));
                }
              }
              wasActive = active;
              // 本地请求还没返回时（busy 还在）也保持快节奏，别等 3 秒。
              running = active || busy !== undefined;
            }
            timer = setTimeout(tick, running ? PROGRESS_MS : IDLE_PROGRESS_MS);
          };
          void tick();
          return () => {
            cancelled = true;
            clearTimeout(timer);
          };
        }, [busy, loadDownloads, pushToast, t]);

        const rows = useMemo(() => {
          const all = Array.isArray(data?.versions) ? data.versions : [];
          return channel === 'all' ? all : all.filter((row) => row.channel === channel);
        }, [data, channel]);

        const selectedRow = useMemo(
          () => (Array.isArray(data?.versions) ? data.versions.find((row) => row.version === selected) : undefined),
          [data, selected],
        );

        const platform = data?.platformDir ?? data?.runtime?.platform ?? '';

        const onRefresh = useCallback(() => { void load(true); }, [load]);

        const onProbe = useCallback(async () => {
          if (probing) return;
          setProbing(true);
          try {
            const targets = rows.slice(0, 24).map((row) => row.version);
            const payload = await apiPost({ op: 'probe', versions: targets });
            const map = new Map((payload.results ?? []).map((item) => [item.version, item]));
            setData((previous) => {
              if (previous === undefined) return previous;
              return {
                ...previous,
                versions: previous.versions.map((row) => {
                  const hit = map.get(row.version);
                  if (hit === undefined) return row;
                  return {
                    ...row,
                    installer: hit.available === true ? 'available' : 'missing',
                    installerSize: hit.size,
                  };
                }),
              };
            });
          } catch (caught) {
            pushToast('error', String(caught?.message ?? caught));
          } finally {
            setProbing(false);
          }
        }, [probing, rows, pushToast]);

        const onDownload = useCallback(async (version) => {
          // 宿主同一时刻只允许一个下载；别的窗口/Agent 工具正在下就别硬上。
          if (progress?.active === true && progress.version !== version) {
            pushToast('warn', t('action.downloadBusy'));
            return;
          }
          setBusy(version);
          setProgress(undefined);
          try {
            const payload = await apiPost({ op: 'download', version });
            if (!alive.current) return;
            setDownloaded((previous) => ({ ...previous, [version]: payload }));
            pushToast('ok', t('action.downloadedAt', { size: payload.sizeText }));
            void loadDownloads();
          } catch (caught) {
            if (alive.current) {
              pushToast('error', t('action.downloadFailed', { message: String(caught?.message ?? caught) }));
            }
          } finally {
            if (alive.current) {
              setBusy(undefined);
              setProgress(undefined);
            }
          }
        }, [t, loadDownloads, progress, pushToast]);

        const onDiscard = useCallback(async (version) => {
          try {
            await apiPost({ op: 'discard', version });
            setDownloaded((previous) => {
              const next = { ...previous };
              delete next[version];
              return next;
            });
            pushToast('ok', t('action.discarded'));
            void loadDownloads();
          } catch (caught) {
            pushToast('error', String(caught?.message ?? caught));
          }
        }, [t, loadDownloads, pushToast]);

        /** 切换版本：启动已下载安装包对应的官方安装程序。 */
        const onSwitch = useCallback(async (version) => {
          if (switchBusy !== undefined) return;
          setSwitchBusy(version);
          try {
            const payload = await apiPost({ op: 'switch', version });
            if (!alive.current) return;
            pushToast('info', t('action.switched', { version }), TOAST_LONG_MS);
            setDownloads((previous) => (previous === undefined
              ? previous
              : { ...previous, pending: payload.pending ?? { version } }));
          } catch (caught) {
            if (alive.current) {
              pushToast('error', t('action.switchFailed', { message: String(caught?.message ?? caught) }));
            }
          } finally {
            if (alive.current) setSwitchBusy(undefined);
          }
        }, [switchBusy, t, pushToast]);

        /** 取消待切换标记。 */
        const onCancelSwitch = useCallback(async () => {
          try {
            await apiPost({ op: 'unswitch' });
            setDownloads((previous) => (previous === undefined ? previous : { ...previous, pending: undefined }));
            pushToast('ok', t('action.switchCancelled'));
          } catch (caught) {
            pushToast('error', String(caught?.message ?? caught));
          }
        }, [t, pushToast]);

        /**
         * 删除某个版本的全部下载（二次确认）。
         *
         * 第一次点击只是「上膛」，PURGE_CONFIRM_MS 内没再点就自动收回——
         * 免得用户点了一下走开，回头又误触把 300 MB 删了。
         */
        const onPurge = useCallback(async (version) => {
          if (purgeArm !== version) {
            setPurgeArm(version);
            return;
          }
          setPurgeArm(undefined);
          try {
            const payload = await apiPost({ op: 'purge', version });
            pushToast('ok', t('action.purged', { version, size: payload.freedText }));
            await loadDownloads();
          } catch (caught) {
            pushToast('error', String(caught?.message ?? caught));
          }
        }, [purgeArm, t, loadDownloads, pushToast]);

        // 「上膛」倒计时：到点自动收回，并给一条可见反馈。
        useEffect(() => {
          if (purgeArm === undefined) {
            setPurgeLeft(0);
            return undefined;
          }
          const seconds = Math.round(PURGE_CONFIRM_MS / 1000);
          setPurgeLeft(seconds);
          const startedAt = Date.now();
          const ticker = setInterval(() => {
            const left = seconds - Math.floor((Date.now() - startedAt) / 1000);
            setPurgeLeft(left > 0 ? left : 0);
          }, 500);
          const timer = setTimeout(() => {
            setPurgeArm(undefined);
            setPurgeLeft(0);
            pushToast('info', t('action.purgeCancelled'), TOAST_MS);
          }, PURGE_CONFIRM_MS);
          return () => {
            clearInterval(ticker);
            clearTimeout(timer);
          };
        }, [purgeArm, t, pushToast]);

        // ---------------- 头部 ----------------
        const currentVersion = data?.runtime?.version;
        const header = h('div', { className: 'dv-head' },
          h('div', { className: 'dv-head-main' },
            h('div', { className: 'dv-title' }, t('panel.title')),
            h('div', { className: 'dv-sub' }, t('panel.subtitle')),
          ),
          h('div', { className: 'dv-current' },
            h('span', { className: 'dv-current-label' }, t('panel.current')),
            h('span', { className: 'dv-current-value' }, typeof currentVersion === 'string' ? currentVersion : t('panel.unknown')),
          ),
          h('button', {
            type: 'button',
            className: 'dv-btn',
            onClick: onRefresh,
            disabled: loading,
            title: t('panel.refresh'),
          }, h(RefreshIcon, { size: 13 }), h('span', null, loading ? t('panel.refreshing') : t('panel.refresh'))),
        );

        // ---------------- 工具栏 ----------------
        const chips = ['all', 'stable', 'rc', 'alpha', 'beta'].map((id) => h('button', {
          key: id,
          type: 'button',
          className: 'dv-chip',
          'data-active': channel === id ? 'true' : 'false',
          onClick: () => setChannel(id),
        }, t(`panel.filter.${id}`)));

        // 视图切换：版本清单 / 已下载
        const tabs = h('div', { className: 'dv-chips dv-tabs' },
          h('button', {
            type: 'button',
            className: 'dv-chip',
            'data-active': view === 'versions' ? 'true' : 'false',
            onClick: () => setView('versions'),
          }, t('tab.versions')),
          h('button', {
            type: 'button',
            className: 'dv-chip',
            'data-active': view === 'downloads' ? 'true' : 'false',
            onClick: () => { setView('downloads'); void loadDownloads(); },
          }, t('tab.downloads'),
          Array.isArray(downloads?.items) && downloads.items.length > 0
            ? h('span', { className: 'dv-tab-count' }, String(downloads.items.length))
            : null),
        );

        const toolbar = h('div', { className: 'dv-toolbar' },
          tabs,
          h('div', { className: 'dv-spacer' }),
          view === 'versions' ? h('div', { className: 'dv-chips' }, ...chips) : null,
          view === 'versions'
            ? h('button', {
              type: 'button',
              className: 'dv-btn',
              onClick: onProbe,
              disabled: probing || rows.length === 0,
            }, probing ? t('panel.probing') : t('panel.probe'))
            : null,
          h('div', { className: 'dv-spacer' }),
          h('div', { className: 'dv-meta' },
            view === 'versions'
              ? t('panel.count', { shown: rows.length, total: data?.total ?? 0 })
              : t('downloads.count', {
                count: downloads?.total ?? 0,
                size: downloads?.totalSizeText ?? '—',
              }),
            platform === '' ? '' : ` · ${t('panel.platform', { platform })}`),
        );

        // ---------------- 提示 ----------------
        // 只剩「加载失败 / 缓存」这类需要常驻的横幅；操作反馈一律走 toast。
        const banners = [];
        if (error !== undefined) {
          banners.push(h('div', { key: 'err', className: 'dv-banner dv-banner-error' },
            t('panel.error', { message: error }),
            ' ',
            h('a', { className: 'dv-link', onClick: () => { void load(true); } }, t('panel.retry')),
          ));
        } else if (data?.stale === true) {
          banners.push(h('div', { key: 'stale', className: 'dv-banner dv-banner-warn' }, t('panel.stale')));
        }

        // ---------------- 全局下载进度 ----------------
        // 与「当前选中哪个版本 / 在哪个视图」完全无关：只要宿主那边有下载在跑就显示。
        // 失败不在这里报（会跟发起方的 toast 重复），由调用方 toast 兜住。
        const globalDownload = (() => {
          const active = progress?.active === true;
          if (active !== true) return null;
          const version = progress?.version ?? busy;
          const percent = progress?.percent;
          const title = typeof version === 'string' && version !== ''
            ? t('download.progressTitle', { version })
            : t('download.progressTitleUnknown');
          return h('div', { className: 'dv-dl-global', 'data-state': 'downloading' },
            h('div', { className: 'dv-dl-global-main' },
              h('div', { className: 'dv-dl-global-title' },
                h('span', { className: 'dv-dl-global-version' }, title),
                percent === undefined
                  ? null
                  : h('span', { className: 'dv-dl-global-meta' }, `${Math.round(percent)}%`),
              ),
              h('div', { className: 'dv-progress-bar' },
                h('div', {
                  className: percent === undefined ? 'dv-progress-fill dv-progress-fill-indeterminate' : 'dv-progress-fill',
                  style: percent === undefined ? undefined : { width: `${Math.min(100, percent)}%` },
                }),
              ),
              h('div', { className: 'dv-dl-global-meta' },
                percent === undefined
                  ? t('download.preparing')
                  : t('download.speed', {
                    received: progress?.receivedText ?? '—',
                    total: progress?.sizeText ?? '—',
                    speed: progress?.speedText ?? '—',
                  })),
            ),
          );
        })();

        // ---------------- 列表 ----------------
        let listBody;
        if (loading && data === undefined) {
          listBody = h('div', { className: 'dv-placeholder' }, t('panel.loading'));
        } else if (rows.length === 0) {
          listBody = h('div', { className: 'dv-placeholder' }, t('panel.empty'));
        } else {
          listBody = rows.map((row) => h(VersionRow, {
            key: row.version,
            row,
            selected: row.version === selected,
            onSelect: setSelected,
          }));
        }

        const list = h('div', { className: 'dv-list' }, ...(Array.isArray(listBody) ? listBody : [listBody]));

        // ---------------- 详情 ----------------
        let detail;
        if (typeof selected !== 'string') {
          detail = h('div', { className: 'dv-detail' },
            h('div', { className: 'dv-placeholder' }, t('detail.pick')),
          );
        } else {
          const row = selectedRow;
          const sections = release === undefined
            ? undefined
            : language === 'en' ? release.en : release.zh;

          const installerState = row?.installer ?? 'unknown';
          // 已下载判定以宿主扫描的下载目录为准（页面刷新后也能认出来），
          // 本次会话里刚下载成功的再用 downloaded 兜一层。
          const localEntry = Array.isArray(downloads?.items)
            ? downloads.items.find((item) => item.version === selected)
            : undefined;
          const alreadyDownloaded = localEntry !== undefined || downloaded[selected] !== undefined;
          const isCurrent = selected === (data?.runtime?.version ?? currentVersion);
          const actionButtons = [];

          if (installerState === 'missing' && !alreadyDownloaded) {
            actionButtons.push(h('div', { key: 'no', className: 'dv-meta' },
              t('action.noInstaller', { platform: platform || data?.runtime?.platform || '' }),
              h('div', { className: 'dv-placeholder-hint' }, t('action.noInstallerHint')),
            ));
          } else if (installerState === 'unknown') {
            actionButtons.push(h('button', {
              key: 'probe',
              type: 'button',
              className: 'dv-btn',
              onClick: onProbe,
              disabled: probing,
            }, probing ? t('action.probing') : t('action.probe')));
          } else if (busy === selected || (progress?.active === true && progress?.version === selected)) {
            // 这个版本正在下载：本地发起的（busy）或别处发起的（宿主 progress）都算。
            actionButtons.push(h('button', {
              key: 'busy', type: 'button', className: 'dv-btn dv-btn-primary', disabled: true,
            }, h(DownloadIcon, { size: 13 }), h('span', null,
              t('action.downloading', {
                percent: progress?.percent !== undefined ? `${Math.round(progress.percent)}%` : '…',
              }))));
          } else if (alreadyDownloaded) {
            if (isCurrent) {
              actionButtons.push(h('span', { key: 'same', className: 'dv-meta' }, t('action.switchSame')));
            } else {
              actionButtons.push(h('button', {
                key: 'switch',
                type: 'button',
                className: 'dv-btn dv-btn-primary',
                onClick: () => { void onSwitch(selected); },
                disabled: switchBusy !== undefined,
              }, h('span', null, switchBusy === selected ? t('action.switching') : t('action.switch'))));
            }
            actionButtons.push(h('button', {
              key: 'again',
              type: 'button',
              className: 'dv-btn dv-btn-ghost',
              onClick: () => { void onDownload(selected); },
            }, h('span', null, t('action.downloaded'))));
            actionButtons.push(h('button', {
              key: 'discard',
              type: 'button',
              className: 'dv-btn dv-btn-ghost',
              onClick: () => { void onDiscard(selected); },
            }, h('span', null, t('action.discard'))));
          } else {
            actionButtons.push(h('button', {
              key: 'download',
              type: 'button',
              className: 'dv-btn dv-btn-primary',
              onClick: () => { void onDownload(selected); },
            }, h(DownloadIcon, { size: 13 }), h('span', null, t('action.download'))));
          }

          const links = [];
          if (release?.compareUrl !== undefined) {
            links.push(h('a', {
              key: 'cmp', className: 'dv-link', href: release.compareUrl, target: '_blank', rel: 'noreferrer',
            }, t('detail.compare')));
          }
          if (release?.url !== undefined) {
            links.push(h('a', {
              key: 'rel', className: 'dv-link', href: release.url, target: '_blank', rel: 'noreferrer',
            }, t('detail.release')));
          }

          let notes;
          if (releaseLoading) {
            notes = h('div', { className: 'dv-placeholder' }, t('detail.loading'));
          } else if (release === undefined) {
            notes = h('div', { className: 'dv-placeholder' }, t('detail.loading'));
          } else if (release.found !== true || (Array.isArray(sections) && sections.length === 0)) {
            notes = h('div', { className: 'dv-placeholder' },
              h('div', null, t('detail.none')),
              h('div', { className: 'dv-placeholder-hint' }, t('detail.noneHint')),
            );
          } else {
            notes = h(ChangelogBody, { sections, language });
          }

          detail = h('div', { className: 'dv-detail' },
            h('div', { className: 'dv-detail-head' },
              h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
                h('div', { className: 'dv-detail-version' }, selected),
                h('div', { className: 'dv-detail-sub' },
                  h('span', null, t('detail.published', { date: formatDate(row?.publishedAt ?? release?.publishedAt) })),
                  row === undefined ? null : h('span', { className: 'dv-dot' }, '·'),
                  row === undefined ? null : h('span', null, channelLabel(row.channel)),
                  row?.installerSize !== undefined && row.installer === 'available'
                    ? h('span', { className: 'dv-dot' }, '·')
                    : null,
                  row?.installerSize !== undefined && row.installer === 'available'
                    ? h('span', null, formatSize(row.installerSize))
                    : null,
                ),
              ),
              h('div', { className: 'dv-langs' },
                h('button', {
                  type: 'button', className: 'dv-chip', 'data-active': language === 'zh' ? 'true' : 'false',
                  onClick: () => setLanguage('zh'),
                }, t('lang.zh')),
                h('button', {
                  type: 'button', className: 'dv-chip', 'data-active': language === 'en' ? 'true' : 'false',
                  onClick: () => setLanguage('en'),
                }, t('lang.en')),
              ),
            ),
            h('div', { className: 'dv-actions' }, ...actionButtons),
            installerState === 'available' && !alreadyDownloaded && busy !== selected
              ? h('div', { className: 'dv-meta' }, t('action.installHint'))
              : null,
            notes,
            links.length > 0 ? h('div', { className: 'dv-links' }, ...links) : null,
          );
        }

        const footer = h('div', { className: 'dv-foot' },
          h('span', null, data?.packageName ?? '@deepseek-ai/dsh'),
          data?.runtime?.channel === undefined ? null : h('span', null, `${t('panel.current')} · ${data.runtime.channel}`),
        );

        // ---------------- 主体：版本清单 / 已下载 ----------------
        const body = view === 'downloads'
          ? h('div', { className: 'dv-body dv-body-single' },
            h(DownloadsList, {
              view: downloads,
              currentVersion,
              onSwitch,
              onPurge,
              onCancelSwitch,
              switchBusy,
              purgeArm,
              purgeLeft,
            }))
          : h('div', { className: 'dv-body' }, list, detail);

        return h('div', { className: 'dv-root' },
          header,
          toolbar,
          ...banners,
          globalDownload,
          body,
          footer,
          toastList.length === 0
            ? null
            : h('div', { className: 'dv-toasts', role: 'status', 'aria-live': 'polite' },
              ...toastList.map((item) => h('div', {
                key: item.id,
                className: item.kind === 'error'
                  ? 'dv-toast dv-toast-error'
                  : item.kind === 'ok' ? 'dv-toast dv-toast-ok'
                    : item.kind === 'warn' ? 'dv-toast dv-toast-warn' : 'dv-toast',
                role: item.kind === 'error' ? 'alert' : 'status',
              },
              h('span', { className: 'dv-toast-text' }, item.text),
              h('button', {
                type: 'button',
                className: 'dv-toast-close',
                title: t('toast.dismiss'),
                onClick: () => dismissToast(item.id),
              }, '×'),
              ))),
        );
      }

      // ------------------------------------------------------------------
      // 插件体
      // ------------------------------------------------------------------
      function apply(ctx) {
        bindLocale(ctx);
        installStyles(ctx);

        const slots = ctx.get('slots');
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[dsh-versions] slots service missing; panel disabled');
          return;
        }

        const register = (slot, options, component, label) => {
          try {
            ctx.effect(
              () => slots.inject(slot, () => slots.register({ name: slot, ...options }, component)),
              label,
            );
          } catch (error) {
            console.warn(`[dsh-versions] could not register ${slot}:`, error?.message ?? error);
          }
        };

        register('sidebar.panellist', {
          id: PANEL_ID,
          order: 58,
          label: () => translateCurrent('panel.title'),
        }, (props) => h(VersionsIcon, { size: props?.size ?? 16 }), 'dsh-versions: sidebar entry');

        register('main', { key: PANEL_ID }, (props) => h(VersionsPage, { ctx, ...props }), 'dsh-versions: version page');
      }

      return {
        inject: ['slots', 'locale'],
        apply,
        // 仅用于冒烟测试；宿主不会读取。
        __test: {
          DICT,
          VersionsPage,
          VersionRow,
          ChangelogBody,
          DownloadsList,
          VersionsIcon,
          formatDate,
          formatSize,
          channelLabel,
          fallbackTranslate,
          CSS,
        },
      };
    },
  });
})();

/**
 * 版本目录的纯文本渲染（Agent 工具输出用）。
 *
 * @module dsh-versions/render
 */

import { formatBytes } from './installer.js';

/** 单次最多列出的版本行数。 */
const MAX_ROWS = 40;

/**
 * 渠道标签。
 * @param {string} channel 渠道。
 * @returns {string} 标签。
 */
export function channelLabel(channel) {
  if (channel === 'stable') return '正式版';
  if (channel === 'rc') return 'RC';
  if (channel === 'alpha') return 'Alpha';
  if (channel === 'beta') return 'Beta';
  return '其它';
}

/**
 * 时间戳 → `YYYY-MM-DD`。
 * @param {number|undefined} value 时间戳。
 * @returns {string} 日期（未知返回 `未知日期`）。
 */
export function formatDate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知日期';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 安装包状态文案。
 * @param {string} state `available` / `missing` / `unknown`。
 * @returns {string} 文案。
 */
export function installerLabel(state) {
  if (state === 'available') return '可下载';
  if (state === 'missing') return '无安装包';
  return '未探测';
}

/**
 * 渲染版本清单。
 * @param {object} overview `Catalog.overview()` 的结果。
 * @param {{channel?: string, limit?: number}} [filter] 过滤。
 * @returns {string} 文本。
 */
export function renderVersionList(overview, filter = {}) {
  const all = Array.isArray(overview?.versions) ? overview.versions : [];
  const channel = typeof filter.channel === 'string' && filter.channel !== 'all' ? filter.channel : undefined;
  const rows = (channel === undefined ? all : all.filter((row) => row.channel === channel))
    .slice(0, Math.min(MAX_ROWS, Math.max(1, Number(filter.limit) || MAX_ROWS)));

  if (rows.length === 0) {
    return `没有匹配的版本（共 ${all.length} 个版本）。${overview?.error === undefined ? '' : `\n数据源错误：${overview.error}`}`;
  }

  const header = [
    `DSH 版本清单（包 ${overview.packageName}，共 ${all.length} 个版本，当前平台 ${overview.platformDir}）`,
    overview.currentVersion === undefined ? '当前版本：未知' : `当前版本：${overview.currentVersion}`,
    '',
  ];
  const lines = rows.map((row) => {
    const marks = [];
    if (row.current === true) marks.push('← 当前');
    if (row.distTags !== undefined) marks.push(row.distTags);
    const parts = [
      `${row.version.padEnd(18)}`,
      channelLabel(row.channel).padEnd(6),
      formatDate(row.publishedAt).padEnd(11),
      row.hasChangelog ? '有更新说明' : '无更新说明',
      `安装包:${installerLabel(row.installer)}`,
    ];
    if (row.installerSize !== undefined) parts.push(formatBytes(row.installerSize));
    if (marks.length > 0) parts.push(marks.join(' '));
    return `- ${parts.join(' · ')}`;
  });
  return [...header, ...lines].join('\n');
}

/**
 * 渲染某个版本的更新说明。
 * @param {{version: string, found: boolean, publishedAt?: number, url?: string, text: string, compareUrl?: string}} release 结果。
 * @param {string} [currentVersion] 当前版本，用于提示这是不是当前版本。
 * @returns {string} 文本。
 */
export function renderRelease(release, currentVersion) {
  if (release === undefined) return '没有拿到更新说明。';
  if (release.found !== true) {
    return `DSH ${release.version} 没有公开的更新说明（该版本没有对应的 GitHub release）。`;
  }
  const head = [
    `DSH ${release.version} 更新说明（发布于 ${formatDate(release.publishedAt)}${release.version === currentVersion ? '，这就是当前安装的版本' : ''}）`,
    release.url === undefined ? '' : release.url,
    '',
  ];
  const body = typeof release.text === 'string' && release.text.trim() !== ''
    ? release.text.trim()
    : '（更新说明为空）';
  return [...head, body].filter((line, index) => line !== '' || index < head.length - 1).join('\n');
}

/**
 * 切换状态说明（待切换 / 已确认）。
 * @param {{pending?: object, applied?: object}} state 状态。
 * @returns {string|undefined} 文本。
 */
export function renderSwitchState(state) {
  const lines = [];
  if (state?.pending !== undefined) {
    lines.push(
      `待切换：${state.pending.version}（后台任务正在关闭 DSH 并静默安装，装完会自动重新打开；完成后当前版本会变成 ${state.pending.version}）`,
    );
    if (typeof state.pending.logPath === 'string' && state.pending.logPath !== '') {
      lines.push(`切换日志：${state.pending.logPath}`);
    }
  }
  if (state?.applied !== undefined) {
    lines.push(`上次切换已完成：${state.applied.version}（${formatDate(state.applied.at)}）`);
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}

/**
 * 渲染已下载安装包清单。
 * @param {{items: Array<object>, total?: number, totalSizeText?: string, dir?: string, pending?: object, applied?: object, currentVersion?: string}} view 下载视图。
 * @returns {string} 文本。
 */
export function renderDownloads(view) {
  const items = Array.isArray(view?.items) ? view.items : [];
  if (items.length === 0) {
    return [
      '本地还没有下载过任何 DSH 安装包。',
      view?.dir === undefined ? '' : `下载目录：${view.dir}`,
      '需要哪个版本就用 dsh_versions_download 下下来，再用 dsh_versions_switch 切换。',
    ].filter((line) => line !== '').join('\n');
  }
  const head = [
    `已下载的 DSH 安装包：${items.length} 个，共 ${view.totalSizeText ?? '未知大小'}`,
    view.dir === undefined ? '' : `下载目录：${view.dir}`,
    '',
  ];
  const rows = items.map((row) => {
    const marks = [];
    if (row.current === true) marks.push('← 当前版本');
    return `- ${row.version.padEnd(18)} ${row.sizeText ?? '未知大小'}${marks.length === 0 ? '' : ` · ${marks.join(' ')}`}`;
  });
  const state = renderSwitchState(view);
  return [...head, ...rows, ...(state === undefined ? [] : ['', state])].join('\n');
}

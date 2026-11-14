/**
 * Agent 侧工具：查版本清单、看更新说明、下载官方安装包、管理已下载版本、切换版本。
 *
 * 工具只做参数校验与文本渲染，真正的数据操作由 index.js 传入的 `ops` 完成，
 * 与面板共用同一条实现路径。
 *
 * 五个工具刻意保持只读或「下载/切换但需人工在安装程序里确认」的形态：Agent 不会
 * 替用户关掉应用去装东西，最后一步始终由用户自己确认。
 *
 * @module dsh-versions/tools
 */

import { renderDownloads, renderRelease, renderSwitchState, renderVersionList } from './render.js';

/** 工具名。 */
export const TOOL_NAMES = {
  list: 'dsh_versions_list',
  release: 'dsh_versions_release',
  download: 'dsh_versions_download',
  downloads: 'dsh_versions_downloads',
  switch: 'dsh_versions_switch',
};

/**
 * 把错误码翻译成人话。
 * @param {string} code 错误码。
 * @returns {string} 说明。
 */
function explain(code) {
  if (code === 'NO_VERSION') return '缺少版本号。';
  if (code === 'NO_INSTALLER') return '该版本没有可用的官方安装包。';
  if (code === 'DOWNLOAD_FAILED') return '下载失败。';
  if (code === 'BUSY') return '已有下载任务在进行中，等它结束再试。';
  if (code === 'NOT_DOWNLOADED') return '这个版本还没下载，先下载再切换。';
  if (code === 'ALREADY_CURRENT') return '当前已经在运行这个版本。';
  if (code === 'LAUNCH_FAILED') return '无法启动安装程序。';
  return `未知错误（${code}）。`;
}

/**
 * 创建工具定义。
 * @param {(definition: object) => object} defineTool 宿主工具 DSL。
 * @param {object} ops 操作集合。
 * @returns {Array<object>} 工具定义。
 */
export function createVersionTools(defineTool, ops) {
  if (typeof defineTool !== 'function') throw new TypeError('createVersionTools requires defineTool');
  const text = (value) => [{ type: 'text', text: value }];

  const listTool = defineTool({
    name: TOOL_NAMES.list,
    description: [
      '列出 DeepSeek Harness（DSH）桌面版的全部历史版本：版本号、发布渠道、发布日期、',
      '是否有更新说明、当前平台有没有官方安装包。',
      '用户问「DSH 有哪些版本 / 最新版本是多少 / 我装的是哪个版本」时用它。',
    ].join(''),
    parameters: {
      channel: {
        type: 'string',
        description: '只看某个渠道：stable 正式版、rc、alpha、beta，all 或省略看全部。',
        enum: ['all', 'stable', 'rc', 'alpha', 'beta'],
      },
      limit: {
        type: 'integer',
        description: '最多列出多少个版本（默认 40，按版本从新到旧）。',
        min: 1,
        max: 40,
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    async execute(args = {}) {
      try {
        const overview = await ops.overview();
        return renderVersionList(overview, { channel: args.channel, limit: args.limit });
      } catch (error) {
        return `读取版本清单失败：${error?.message ?? error}`;
      }
    },
  });

  const releaseTool = defineTool({
    name: TOOL_NAMES.release,
    description: [
      '读取 DSH 某个版本的更新说明（changelog）：新增功能、问题修复、体验优化。',
      '用户问「某版本更新了什么 / 最新版有什么变化 / 从 X 升到 Y 有哪些改动」时用它。',
    ].join(''),
    parameters: {
      version: {
        type: 'string',
        required: true,
        description: '版本号，例如 0.2.2-rc.3；省略时取 npm 上的 latest。',
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    async execute(args = {}) {
      try {
        const info = ops.runtime();
        let version = typeof args.version === 'string' ? args.version.trim() : '';
        if (version === '') {
          const overview = await ops.overview();
          version = overview.distTags?.latest ?? overview.versions?.[0]?.version ?? '';
        }
        if (version === '') return '缺少版本号，而且拿不到 latest。';
        const release = await ops.release(version);
        return renderRelease(release, info.version);
      } catch (error) {
        return `读取更新说明失败：${error?.message ?? error}`;
      }
    },
  });

  const downloadTool = defineTool({
    name: TOOL_NAMES.download,
    description: [
      '把指定版本的 DSH 官方桌面安装包下载到本地（不走 npm，直接取官方下载站的分发产物）。',
      '下载完成后告诉用户安装包路径，由用户自己双击安装——它不会替你关闭当前应用或执行安装。',
      '只有 win-x64 等有官方产物的平台和版本才能下载；先不带版本号查一次清单再决定。',
    ].join(''),
    parameters: {
      version: {
        type: 'string',
        required: true,
        description: '要下载的版本号，例如 0.2.2-rc.3。',
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => false,
    timeoutMs: 15 * 60_000,
    async execute(args = {}) {
      const version = typeof args.version === 'string' ? args.version.trim() : '';
      if (version === '') return `下载失败：${explain('NO_VERSION')}`;
      try {
        const result = await ops.download(version);
        if (result.ok !== true) {
          const code = result.code ?? 'DOWNLOAD_FAILED';
          return `下载 ${version} 失败：${explain(code)}${result.error === undefined ? '' : `（${result.error}）`}`;
        }
        return [
          `已下载 DSH ${version} 的官方安装包（${result.sizeText}）：`,
          result.path,
          '',
          '下一步由用户自己完成：关闭当前 DSH 后双击该安装包即可升级。插件不会自动执行安装。',
          `如果用户想现在就切换，可以再调用 ${TOOL_NAMES.switch}（它会启动安装程序，同样需要用户点确认）。`,
        ].join('\n');
      } catch (error) {
        return `下载 ${version} 失败：${error?.message ?? error}`;
      }
    },
  });

  const downloadsTool = defineTool({
    name: TOOL_NAMES.downloads,
    description: [
      '列出本地已经下载好的 DSH 安装包：版本号、大小、哪个是当前正在运行的版本，',
      '以及有没有「待切换 / 上次切换完成」的记录。',
      '用户问「我下过哪些版本 / 本地占了多大空间 / 有没有下好某个版本」时用它。',
    ].join(''),
    parameters: {
      version: {
        type: 'string',
        description: '只看某个版本是否已下载；省略时列出全部。',
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    timeoutMs: 20_000,
    async execute(args = {}) {
      try {
        const view = ops.downloads();
        const version = typeof args.version === 'string' ? args.version.trim() : '';
        if (version === '') return renderDownloads(view);
        const hit = (view.items ?? []).find((row) => row.version === version);
        if (hit === undefined) {
          return `本地没有 ${version} 的安装包。用 ${TOOL_NAMES.download} 可以把它下下来。`;
        }
        const parts = [
          `已下载 ${version} 的安装包（${hit.sizeText}）：`,
          hit.path,
        ];
        if (hit.current === true) parts.push('注意：这正是当前运行的版本。');
        const state = renderSwitchState(view);
        if (state !== undefined) parts.push('', state);
        return parts.join('\n');
      } catch (error) {
        return `读取已下载列表失败：${error?.message ?? error}`;
      }
    },
  });

  const switchTool = defineTool({
    name: TOOL_NAMES.switch,
    description: [
      '把 DSH 切换（回退/升级）到某个**已经下载好**的版本：启动那个版本的官方安装程序，',
      '并记下这次切换意图，之后面板会确认切换是否生效。',
      '它不会静默替换文件，也不会关掉当前 DSH——安装程序需要用户自己点确认。',
      '没下载过的版本会失败，先用 dsh_versions_download。',
    ].join(''),
    parameters: {
      version: {
        type: 'string',
        required: true,
        description: '要切换到的版本号，例如 0.2.1-rc.5；必须是本地已下载的版本。',
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute(args = {}) {
      const version = typeof args.version === 'string' ? args.version.trim() : '';
      if (version === '') return `切换失败：${explain('NO_VERSION')}`;
      try {
        const result = ops.switchTo(version);
        if (result.ok !== true) {
          const code = result.code ?? 'LAUNCH_FAILED';
          return `切换 ${version} 失败：${explain(code)}${result.error === undefined ? '' : `（${result.error}）`}`;
        }
        return [
          `已启动 DSH ${version} 的官方安装程序：`,
          result.path,
          '',
          '接下来由用户在安装程序里确认（可能需要先退出 DSH）。装完后重新打开 DSH，',
          `版本会变成 ${version}；面板和 ${TOOL_NAMES.downloads} 会确认这次切换已生效。`,
        ].join('\n');
      } catch (error) {
        return `切换 ${version} 失败：${error?.message ?? error}`;
      }
    },
  });

  return [listTool, releaseTool, downloadTool, downloadsTool, switchTool];
}

/**
 * 插件设置（Config schema）。
 *
 * `settings.describe` 会读取每个节点的 `schema.meta.volatile`；根节点缺少 meta
 * 会让桌面欢迎页的 settings 请求直接抛错，所以这里用 `descriptor()` 给每个
 * 节点补齐 meta，包括根节点。
 *
 * 单独成文件是为了让离线冒烟测试能只导入 schema 而不加载 Host 半边
 * （Host 半边会 import `@deepseek-ai/dsh-tools`，那是宿主才有的包）。
 *
 * @module dsh-versions/config
 */

const field = (type, description, extra = {}) => ({
  type,
  meta: { volatile: true, description },
  ...extra,
});

/** 设置项描述。 */
export const CONFIG_FIELDS = {
  dataDir: field(
    'string',
    '版本缓存与安装包存放目录；留空表示 <用户目录>/.dsh/dsh-versions。',
  ),
  cacheMinutes: field(
    'integer',
    '版本清单与更新说明列表的缓存分钟数，过期后重新拉取（失败会退回旧缓存）。',
    { min: 1, max: 1440 },
  ),
  probeInstallers: field(
    'boolean',
    '打开面板时自动探测哪些版本有官方安装包（每个版本一次 HEAD 请求，结果缓存 7 天）。',
  ),
  promptContext: field(
    'boolean',
    '把当前 DSH 版本与更新通道作为运行时上下文挂进每一步，让 Agent 知道自己在哪个版本上工作。',
  ),
};

/** 默认设置。 */
export const DEFAULTS = {
  dataDir: '',
  cacheMinutes: 30,
  probeInstallers: true,
  promptContext: true,
};

/**
 * 把行配置补齐成完整设置。
 * @param {unknown} raw 行配置。
 * @returns {typeof DEFAULTS} 完整设置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const integer = (value, fallback, min, max) => {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(number)));
  };
  return {
    dataDir: typeof source.dataDir === 'string' ? source.dataDir.trim() : DEFAULTS.dataDir,
    cacheMinutes: integer(source.cacheMinutes, DEFAULTS.cacheMinutes, 1, 1440),
    probeInstallers: typeof source.probeInstallers === 'boolean'
      ? source.probeInstallers
      : DEFAULTS.probeInstallers,
    promptContext: typeof source.promptContext === 'boolean'
      ? source.promptContext
      : DEFAULTS.promptContext,
  };
}

/**
 * 给 schema 每个节点补 `meta`。
 * @param {object} node schema 节点。
 * @returns {object} 补齐后的节点。
 */
export function descriptor(node) {
  const result = {
    ...node,
    meta: { ...(node.meta ?? {}) },
    toJSON() {
      return JSON.parse(JSON.stringify({ ...this, toJSON: undefined }));
    },
  };
  if (node.dict !== undefined) {
    result.dict = Object.fromEntries(
      Object.entries(node.dict).map(([key, child]) => [key, descriptor(child)]),
    );
  }
  return result;
}

/** 插件设置 schema。 */
export const Config = Object.assign(descriptor({ type: 'object', dict: CONFIG_FIELDS }), {
  '~standard': {
    version: 1,
    vendor: 'dsh-versions',
    validate(value) {
      try {
        return { value: normalizeConfig(value) };
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
      }
    },
  },
});

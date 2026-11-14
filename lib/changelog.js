/**
 * 更新说明（GitHub release body）解析。
 *
 * DSH 的 release 正文是双语 Markdown：
 *
 * ```md
 * [中文](#cn) | [English](#en)
 *
 * <h3 id="cn">新增功能</h3>
 *
 * - 一条…
 *
 * ### 问题修复
 *
 * - 一条…
 *
 * <h3 id="en">New Features</h3>
 *
 * - One…
 *
 * Full Changelog: https://github.com/.../compare/a...b
 * ```
 *
 * 面板要把中英两份分开渲染，所以这里把它拆成
 * `{ zh: [{title, items}], en: [{title, items}], compareUrl }`。
 * 解析失败一律降级成「原文单段」，不抛错——更新说明只是展示内容。
 *
 * @module dsh-versions/changelog
 */

/** 语言标记：`<h3 id="cn">` / `<h3 id="cn-0.2.0-rc.1">` / `<h3 id="en-…">`。 */
const LANGUAGE_MARK = /<h3[^>]*\bid=["'](cn|en)(?:-[^"']*)?["'][^>]*>(.*?)<\/h3>/iu;

/** 普通标题：`### 问题修复` / `## Title` / `<h3 id="…">Title</h3>`。 */
const HEADING = /^(?:#{2,4}\s+(.+?)\s*|<h3[^>]*>(.*?)<\/h3>)$/u;

/** 列表项：`- xxx` / `* xxx` / `+ xxx`。 */
const BULLET = /^[-*+]\s+(.+)$/u;

/** Full Changelog 链接行。 */
const COMPARE = /^Full Changelog:\s*(\S+)/iu;

/** 中文字符，用于在缺少语言标记时猜语言。 */
const CJK = /[\u4e00-\u9fff]/u;

/**
 * 清掉行内 Markdown 噪音：加粗标记与多余空白。
 * @param {string} text 文本。
 * @returns {string} 清理结果。
 */
function cleanText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 去掉一条列表项末尾的作者署名（`@name` / `by @name` / `@a @b`）。
 *
 * 只吃掉署名本身与它前面的空白，不动句末标点：`修复 xxx。@winewill` 应当留下
 * `修复 xxx。`，而不是把句号一起删掉。
 *
 * @param {string} text 列表项文本。
 * @returns {{text: string, authors: string[]}} 正文与作者。
 */
function splitAuthors(text) {
  const authors = [];
  const trailing = /(?:\s+by\s+@([A-Za-z0-9-]+)|\s*@([A-Za-z0-9-]+))\s*$/iu;
  let rest = text.trim();
  for (;;) {
    const match = trailing.exec(rest);
    if (match === null) break;
    const name = match[1] ?? match[2];
    if (typeof name !== 'string' || name === '') break;
    authors.unshift(name);
    rest = rest.slice(0, match.index).trim();
  }
  // 全角句号后可能还留着空格。
  rest = rest.replace(/\s+$/u, '');
  return { text: rest, authors };
}

/**
 * 把一个语言段落切成 `[{title, items}]`。
 * @param {Array<string>} lines 行。
 * @returns {Array<{title: string, items: Array<{text: string, authors: string[]}>}>} 段落。
 */
function toSections(lines) {
  const sections = [];
  let current = { title: '', items: [] };
  const flush = () => {
    if (current.title !== '' || current.items.length > 0) sections.push(current);
    current = { title: '', items: [] };
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line === '---' || line.startsWith('[中文]')) continue;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      current.title = cleanText(heading[1] ?? heading[2] ?? '');
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      const item = splitAuthors(cleanText(bullet[1]));
      if (item.text !== '') current.items.push(item);
      continue;
    }
    // 段落正文（例如「作为 0.2.0 系列的首个候选版本…」）当作无标题段的一行。
    const text = cleanText(line);
    if (text !== '') current.items.push({ text, authors: [] });
  }
  flush();
  return sections.filter((section) => section.title !== '' || section.items.length > 0);
}

/**
 * 解析 release 正文。
 * @param {unknown} body release body。
 * @returns {{zh: Array<object>, en: Array<object>, compareUrl?: string, raw: string, empty: boolean}} 解析结果。
 */
export function parseReleaseBody(body) {
  const raw = typeof body === 'string' ? body : '';
  const text = raw.replace(/\r\n?/gu, '\n');
  const lines = text.split('\n');
  const buckets = { zh: [], en: [] };
  /** 当前语言桶名（`zh` / `en`）；undefined 表示还没遇到语言标记。 */
  let language;
  let compareUrl;

  for (const line of lines) {
    const compare = COMPARE.exec(line.trim());
    if (compare !== null) {
      compareUrl = compare[1];
      continue;
    }
    const mark = LANGUAGE_MARK.exec(line);
    if (mark !== null) {
      // 标记 `cn` 归到中文桶，`en` 归到英文桶。
      language = mark[1].toLowerCase() === 'cn' ? 'zh' : 'en';
      // 标记行本身可能自带标题（`<h3 id="cn">新增功能</h3>`），当成一级标题喂回去。
      const title = cleanText(mark[2] ?? '');
      if (title !== '') buckets[language].push(`### ${title}`);
      continue;
    }
    if (language === undefined) {
      // 还没出现语言标记：按内容猜，之后遇到标记会重新分流。
      language = CJK.test(line) ? 'zh' : 'en';
    }
    buckets[language].push(line);
  }

  const zh = toSections(buckets.zh);
  const en = toSections(buckets.en);

  // 没有语言标记、整段都进了同一桶时，另一桶补一份，让中英视图都有内容。
  if (zh.length === 0 && en.length > 0) zh.push(...en.map((section) => ({ ...section })));
  if (en.length === 0 && zh.length > 0) en.push(...zh.map((section) => ({ ...section })));

  return {
    zh,
    en,
    compareUrl,
    raw,
    empty: zh.length === 0 && en.length === 0,
  };
}

/**
 * 把解析结果折算成一段纯文本（供 Agent 工具与提示词使用）。
 * @param {{zh: Array<object>, en: Array<object>, compareUrl?: string}} parsed 解析结果。
 * @param {'zh'|'en'} language 语言。
 * @returns {string} 纯文本。
 */
export function renderReleaseText(parsed, language) {
  const sections = language === 'en' ? parsed.en : parsed.zh;
  const parts = [];
  for (const section of sections) {
    if (section.title !== '') parts.push(`【${section.title}】`);
    for (const item of section.items) {
      const authors = item.authors.length > 0 ? `（@${item.authors.join(' @')}）` : '';
      parts.push(`- ${item.text}${authors}`);
    }
  }
  if (parsed.compareUrl !== undefined) parts.push(`完整对比：${parsed.compareUrl}`);
  return parts.join('\n');
}

/**
 * 客户端冒烟测试：用最小 fake React + fake 宿主 facade 把 client.js 跑一遍，
 * 确认注册了正确的 slot、面板能渲染、文案齐全。
 *
 * 运行：node test/client.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    process.stdout.write(`FAIL ${name}\n`);
    throw error;
  }
}

/** 极简 React 替身：createElement 只产出可检查的节点树。 */
function createReact() {
  const Fragment = Symbol('Fragment');
  const createElement = (type, props, ...children) => ({
    type,
    props: props === null || props === undefined ? {} : props,
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  });
  const hooks = { index: 0, states: [] };
  return {
    Fragment,
    createElement,
    useState(initial) {
      const index = hooks.index;
      hooks.index += 1;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initial === 'function' ? initial() : initial;
      }
      return [hooks.states[index], (next) => {
        hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next;
      }];
    },
    useEffect() { hooks.index += 1; },
    useMemo(factory) { hooks.index += 1; return factory(); },
    useCallback(fn) { hooks.index += 1; return fn; },
    useRef(value) { hooks.index += 1; return { current: value }; },
    __hooks: hooks,
  };
}

/** 把一个渲染树压成纯文本，便于断言文案（函数组件就地展开）。 */
function textOf(node, depth = 0) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => textOf(child, depth)).join(' ');
  if (typeof node.type === 'function' && depth < 8) {
    return textOf(node.type(node.props), depth + 1);
  }
  return textOf(node.children, depth);
}

/** 收集树里所有 className（函数组件就地展开）。 */
function classesOf(node, found = [], depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) classesOf(child, found, depth);
    return found;
  }
  if (typeof node.props?.className === 'string') found.push(node.props.className);
  if (typeof node.type === 'function' && depth < 8) {
    classesOf(node.type(node.props), found, depth + 1);
    return found;
  }
  classesOf(node.children, found, depth);
  return found;
}

const React = createReact();
const registered = [];
const effects = [];
const styleTags = [];

const slots = {
  inject(name, factory) {
    registered.push({ slot: name, factory });
    return () => {};
  },
  register(options, component) {
    return { options, component };
  },
};

const ctx = {
  get(service) {
    if (service === 'slots') return slots;
    if (service === 'locale') return undefined;
    return undefined;
  },
  effect(factory, label) {
    effects.push(label);
    const dispose = factory();
    return () => { if (typeof dispose === 'function') dispose(); };
  },
};

const document = {
  head: {
    appendChild(node) { styleTags.push(node); },
  },
  createElement(tag) {
    return { tag, dataset: {}, textContent: '', remove() {} };
  },
};

let factoryResult;
const window = {
  location: { origin: 'http://127.0.0.1:60016' },
  __ModuleLoader__: {
    factories: new Map(),
    load({ id, factory }) {
      window.__ModuleLoader__.factories.set(id, factory);
      factoryResult = factory((name) => {
        if (name === 'react') return React;
        throw new Error(`unexpected require: ${name}`);
      });
    },
  },
};

const context = vm.createContext({
  window,
  document,
  console,
  fetch: async () => { throw new Error('no network in tests'); },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  URL,
});

vm.runInContext(source, context, { filename: 'client.js' });

try {
  test('client.js 注册了模块并返回 inject/apply', () => {
    assert.ok(window.__ModuleLoader__.factories.has('@restregular/dsh-versions'));
    assert.equal(typeof factoryResult.apply, 'function');
    assert.deepEqual([...factoryResult.inject], ['slots', 'locale']);
  });

  test('apply 注册侧边栏入口与主面板', () => {
    factoryResult.apply(ctx);
    const slotsRegistered = registered.map((item) => item.slot);
    assert.ok(slotsRegistered.includes('sidebar.panellist'), slotsRegistered.join(','));
    assert.ok(slotsRegistered.includes('main'), slotsRegistered.join(','));
    assert.equal(styleTags.length, 1, '应注入一份样式');
    assert.match(styleTags[0].textContent, /\.dv-root/u);
    assert.ok(!/--dsw-[a-z]+-[a-z-]+:\s*(#|rgb)/u.test(styleTags[0].textContent), '不应写死颜色');
  });

  test('__test 暴露可测函数', () => {
    const api = factoryResult.__test;
    assert.equal(typeof api.VersionsPage, 'function');
    assert.equal(typeof api.formatDate, 'function');
    assert.equal(api.formatDate(Date.UTC(2026, 10, 13)), '2026-11-13');
    assert.equal(api.formatDate(undefined), '—');
    assert.equal(api.formatSize(299595752), '285.7 MB');
    assert.equal(api.formatSize(0), '—');
    assert.equal(api.channelLabel('stable'), '正式版');
  });

  test('中英字典键一一对应', () => {
    const dict = factoryResult.__test.DICT;
    const zhKeys = Object.keys(dict.zh).sort();
    const enKeys = Object.keys(dict.en).sort();
    assert.deepEqual(enKeys, zhKeys);
  });

  test('fallbackTranslate 支持占位符与缺失键', () => {
    const translate = factoryResult.__test.fallbackTranslate;
    assert.equal(translate('panel.current'), '当前版本');
    assert.equal(translate('panel.count', { shown: 3, total: 44 }), '3 / 44 个版本');
    assert.equal(translate('missing.key'), 'missing.key');
  });

  test('版本行渲染当前/渠道/安装包标记', () => {
    const row = {
      version: '0.2.2-rc.3',
      channel: 'rc',
      publishedAt: Date.UTC(2026, 10, 13),
      hasChangelog: true,
      installer: 'available',
      installerSize: 299595752,
      current: true,
    };
    const node = React.createElement(factoryResult.__test.VersionRow, { row, selected: true, onSelect() {} });
    const rendered = factoryResult.__test.VersionRow({ row, selected: true, onSelect() {} });
    const text = textOf(rendered);
    assert.match(text, /0\.2\.2-rc\.3/u);
    assert.match(text, /当前/u);
    assert.match(text, /RC/u);
    assert.match(text, /可下载/u);
    assert.match(text, /285\.7 MB/u);
    assert.ok(classesOf(rendered).includes('dv-row'));
    assert.equal(node.props.row.version, '0.2.2-rc.3');
  });

  test('更新说明渲染分节与条目', () => {
    const sections = [
      { title: '新增功能', items: [{ text: '一条改动', authors: ['imccyu'] }] },
      { title: '问题修复', items: [] },
    ];
    const rendered = factoryResult.__test.ChangelogBody({ sections, language: 'zh' });
    const text = textOf(rendered);
    assert.match(text, /新增功能/u);
    assert.match(text, /一条改动/u);
    assert.match(text, /@imccyu/u);
    assert.match(text, /问题修复/u);
    assert.match(text, /这一节没有条目/u);
  });

  test('更新说明空内容给占位', () => {
    const rendered = factoryResult.__test.ChangelogBody({ sections: [], language: 'zh' });
    assert.match(textOf(rendered), /没有公开的更新说明/u);
  });

  test('主面板在无数据时渲染骨架（不抛错）', () => {
    React.__hooks.index = 0;
    React.__hooks.states = [];
    const rendered = factoryResult.__test.VersionsPage({ ctx });
    const text = textOf(rendered);
    assert.match(text, /版本历史/u);
    assert.match(text, /正在读取版本清单/u);
    const classes = classesOf(rendered);
    assert.ok(classes.includes('dv-root'), classes.join(','));
    assert.ok(classes.includes('dv-list'));
    assert.ok(classes.includes('dv-detail'));
  });

  test('主面板能渲染版本列表与详情（注入快照数据）', () => {
    React.__hooks.index = 0;
    // useState 顺序：data, loading, error, channel, selected, release,
    // releaseLoading, language, probing, busy, downloaded, progress, notice。
    React.__hooks.states = [
      undefined,
      false,
      undefined,
      'all',
      '0.2.2-rc.3',
      { ok: true, found: true, version: '0.2.2-rc.3', zh: [{ title: '新增功能', items: [{ text: '一条改动', authors: [] }] }], en: [{ title: 'New Features', items: [{ text: 'one change', authors: [] }] }], compareUrl: 'https://github.com/x/y/compare/a...b', url: 'https://github.com/x/y/releases/tag/dsh-v0.2.2-rc.3' },
      false,
      'zh',
      false,
      undefined,
      {},
      undefined,
      undefined,
    ];
    React.__hooks.states[0] = {
      ok: true,
      packageName: '@deepseek-ai/dsh',
      platformDir: 'win-x64',
      total: 2,
      stale: false,
      runtime: { version: '0.2.2-rc.3', platform: 'win32', channel: 'nightly' },
      versions: [
        { version: '0.2.2-rc.3', channel: 'rc', publishedAt: Date.UTC(2026, 10, 13), hasChangelog: true, installer: 'available', installerSize: 299595752, current: true },
        { version: '0.1.0-rc.7', channel: 'rc', publishedAt: Date.UTC(2026, 8, 1), hasChangelog: true, installer: 'missing' },
      ],
    };
    const rendered = factoryResult.__test.VersionsPage({ ctx });
    const text = textOf(rendered);
    assert.match(text, /0\.2\.2-rc\.3/u);
    assert.match(text, /0\.1\.0-rc\.7/u);
    assert.match(text, /当前版本/u);
    assert.match(text, /win-x64/u);
    assert.match(text, /新增功能/u);
    assert.match(text, /一条改动/u);
    assert.match(text, /下载安装包/u);
    assert.match(text, /2 \/ 2 个版本/u);
    const classes = classesOf(rendered);
    assert.ok(classes.filter((name) => name === 'dv-row').length >= 1);
  });

  test('无安装包的版本给出说明而不是下载按钮', () => {
    React.__hooks.index = 0;
    React.__hooks.states = [
      {
        ok: true,
        packageName: '@deepseek-ai/dsh',
        platformDir: 'win-x64',
        total: 1,
        runtime: { version: '0.2.2-rc.3' },
        versions: [
          { version: '0.1.0-rc.7', channel: 'rc', publishedAt: Date.UTC(2026, 8, 1), hasChangelog: true, installer: 'missing' },
        ],
      },
      false,
      undefined,
      'all',
      '0.1.0-rc.7',
      { ok: true, found: false, version: '0.1.0-rc.7', zh: [], en: [] },
      false,
      'zh',
      false,
      undefined,
      {},
      undefined,
      undefined,
    ];
    const rendered = factoryResult.__test.VersionsPage({ ctx });
    const text = textOf(rendered);
    assert.match(text, /没有官方安装包/u);
    assert.match(text, /只能用 npm 安装/u);
    assert.match(text, /没有公开的更新说明/u);
    assert.ok(!text.includes('下载安装包'), '不该出现下载按钮');
  });

  test('已下载列表渲染当前版本、切换与删除', () => {
    const view = {
      items: [
        { version: '0.2.2-rc.3', path: 'C:/x/0.2.2-rc.3/dsh.exe', size: 299595752, sizeText: '285.7 MB', current: true },
        { version: '0.2.1-rc.5', path: 'C:/x/0.2.1-rc.5/dsh.exe', size: 290000000, sizeText: '276.6 MB', current: false },
      ],
      total: 2,
      totalSize: 589595752,
      totalSizeText: '562.3 MB',
      dir: 'C:/x/downloads',
      pending: { version: '0.2.1-rc.5', at: Date.UTC(2026, 10, 14) },
    };
    const rendered = factoryResult.__test.DownloadsList({
      view,
      currentVersion: '0.2.2-rc.3',
      onSwitch() {},
      onPurge() {},
      onCancelSwitch() {},
      switchBusy: undefined,
      purgeArm: undefined,
    });
    const text = textOf(rendered);
    assert.match(text, /已下载/u);
    assert.match(text, /0\.2\.2-rc\.3/u);
    assert.match(text, /0\.2\.1-rc\.5/u);
    assert.match(text, /285\.7 MB/u);
    assert.match(text, /562\.3 MB/u);
    assert.match(text, /当前/u, '当前版本要标记');
    assert.match(text, /切换/u);
    assert.match(text, /删除/u);
    assert.match(text, /待切换：0\.2\.1-rc\.5/u);
    assert.match(text, /取消切换/u);
    assert.match(text, /C:\/x\/downloads/u, '要显示下载目录');
    const classes = classesOf(rendered);
    assert.ok(classes.includes('dv-dl-row'), classes.join(','));
  });

  test('已下载列表为空时给引导文案', () => {
    const rendered = factoryResult.__test.DownloadsList({
      view: { items: [], total: 0, totalSize: 0, totalSizeText: '0 B', dir: 'C:/x' },
      currentVersion: '0.2.2-rc.3',
      onSwitch() {},
      onPurge() {},
      onCancelSwitch() {},
      switchBusy: undefined,
      purgeArm: undefined,
    });
    const text = textOf(rendered);
    assert.match(text, /还没有下载过安装包/u);
    assert.match(text, /下载安装包/u, '要告诉用户去哪儿下');
    assert.ok(!classesOf(rendered).includes('dv-dl-row'), '空列表不该有行');
  });

  test('面板能切到「已下载」视图', () => {
    React.__hooks.index = 0;
    React.__hooks.states = [
      {
        ok: true,
        packageName: '@deepseek-ai/dsh',
        platformDir: 'win-x64',
        total: 1,
        runtime: { version: '0.2.2-rc.3' },
        versions: [
          { version: '0.2.2-rc.3', channel: 'rc', publishedAt: Date.UTC(2026, 10, 13), hasChangelog: true, installer: 'available', current: true },
        ],
      },
      false,
      undefined,
      'all',
      '0.2.2-rc.3',
      undefined,
      false,
      'zh',
      false,
      undefined,
      {},
      undefined,
      undefined,
      // 追加的状态：view, downloads, switchBusy, purgeArm
      'downloads',
      {
        items: [{ version: '0.2.1-rc.5', path: 'C:/x/dsh.exe', size: 290000000, sizeText: '276.6 MB', current: false }],
        total: 1,
        totalSize: 290000000,
        totalSizeText: '276.6 MB',
        dir: 'C:/x',
      },
      undefined,
      undefined,
    ];
    const rendered = factoryResult.__test.VersionsPage({ ctx });
    const text = textOf(rendered);
    assert.match(text, /已下载/u);
    assert.match(text, /0\.2\.1-rc\.5/u);
    assert.match(text, /1 个 · 276\.6 MB/u, '工具栏显示已下载汇总');
    const classes = classesOf(rendered).flatMap((name) => name.split(/\s+/u));
    assert.ok(classes.includes('dv-body-single'), '已下载视图不该再分左右两栏');
    assert.ok(!classes.includes('dv-list'), '已下载视图不渲染版本列表');
  });

  test('下载进度不跟随选中版本：换版本后仍在页面上', () => {
    React.__hooks.index = 0;
    React.__hooks.states = [
      {
        ok: true,
        packageName: '@deepseek-ai/dsh',
        platformDir: 'win-x64',
        total: 2,
        runtime: { version: '0.2.2-rc.3' },
        versions: [
          { version: '0.2.2-rc.3', channel: 'rc', publishedAt: Date.UTC(2026, 10, 13), hasChangelog: true, installer: 'available', current: true },
          { version: '0.2.1-rc.5', channel: 'rc', publishedAt: Date.UTC(2026, 10, 1), hasChangelog: true, installer: 'available' },
        ],
      },
      false,
      undefined,
      'all',
      // 用户已经切到另一个版本了，但下载还在跑的是 0.2.1-rc.5。
      '0.2.2-rc.3',
      { ok: true, found: true, version: '0.2.2-rc.3', zh: [], en: [] },
      false,
      'zh',
      false,
      undefined,
      {},
      {
        ok: true,
        active: true,
        version: '0.2.1-rc.5',
        state: 'downloading',
        percent: 42,
        received: 120000000,
        total: 285000000,
        receivedText: '114.4 MB',
        sizeText: '271.8 MB',
        speedText: '3.1 MB/s',
      },
      [],
      'versions',
      { items: [], total: 0, totalSizeText: '0 B', dir: 'C:/x' },
      undefined,
      undefined,
      0,
    ];
    const rendered = factoryResult.__test.VersionsPage({ ctx });
    const text = textOf(rendered);
    assert.match(text, /正在下载 0\.2\.1-rc\.5/u, '进度要显示真正在下的那个版本');
    assert.match(text, /42%/u);
    assert.match(text, /3\.1 MB\/s/u);
    assert.ok(classesOf(rendered).includes('dv-dl-global'), '要有页面级下载进度条');
  });

  test('切到「已下载」视图时下载进度依然可见', () => {
    React.__hooks.index = 0;
    React.__hooks.states = [
      { ok: true, packageName: '@deepseek-ai/dsh', platformDir: 'win-x64', total: 0, runtime: { version: '0.2.2-rc.3' }, versions: [] },
      false,
      undefined,
      'all',
      '0.2.2-rc.3',
      undefined,
      false,
      'zh',
      false,
      undefined,
      {},
      { ok: true, active: true, version: '0.2.1-rc.5', percent: 7, receivedText: '20 MB', sizeText: '271.8 MB', speedText: '1 MB/s' },
      [],
      'downloads',
      { items: [], total: 0, totalSizeText: '0 B', dir: 'C:/x' },
      undefined,
      undefined,
      0,
    ];
    const rendered = factoryResult.__test.VersionsPage({ ctx });
    assert.match(textOf(rendered), /正在下载 0\.2\.1-rc\.5/u);
    assert.ok(classesOf(rendered).includes('dv-dl-global'));
  });

  test('操作反馈走 toast，不再占顶部横幅', () => {
    React.__hooks.index = 0;
    React.__hooks.states = [
      { ok: true, packageName: '@deepseek-ai/dsh', platformDir: 'win-x64', total: 0, runtime: { version: '0.2.2-rc.3' }, versions: [] },
      false,
      undefined,
      'all',
      undefined,
      undefined,
      false,
      'zh',
      false,
      undefined,
      {},
      { ok: true, active: false },
      [
        { id: 1, kind: 'ok', text: '已下载 271.8 MB' },
        { id: 2, kind: 'error', text: '下载失败：HTTP 404' },
      ],
      'versions',
      undefined,
      undefined,
      undefined,
      0,
    ];
    const rendered = factoryResult.__test.VersionsPage({ ctx });
    const text = textOf(rendered);
    assert.match(text, /已下载 271\.8 MB/u);
    assert.match(text, /下载失败：HTTP 404/u);
    const classes = classesOf(rendered).flatMap((name) => name.split(/\s+/u));
    assert.ok(classes.includes('dv-toasts'), '要有 toast 容器');
    assert.ok(classes.includes('dv-toast-error'), '错误 toast 要有独立样式');
    assert.ok(!classes.includes('dv-banner'), '操作反馈不该再走横幅');
    assert.ok(!classes.includes('dv-dl-global'), '没在下载就不显示进度条');
  });

  test('删除按钮的二次确认显示倒计时，超时由组件自动收回', () => {
    const view = {
      items: [{ version: '0.2.1-rc.5', path: 'C:/x/dsh.exe', size: 290000000, sizeText: '276.6 MB', current: false }],
      total: 1,
      totalSize: 290000000,
      totalSizeText: '276.6 MB',
      dir: 'C:/x',
    };
    const armed = factoryResult.__test.DownloadsList({
      view,
      currentVersion: '0.2.2-rc.3',
      onSwitch() {},
      onPurge() {},
      onCancelSwitch() {},
      switchBusy: undefined,
      purgeArm: '0.2.1-rc.5',
      purgeLeft: 3,
    });
    const armedText = textOf(armed);
    assert.match(armedText, /再点一次确认删除 0\.2\.1-rc\.5/u);
    assert.match(armedText, /3 秒后自动取消/u);
    const classes = classesOf(armed).flatMap((name) => name.split(/\s+/u));
    assert.ok(classes.includes('dv-btn-danger'), '上膛状态要有危险色');

    // 没给 purgeLeft 时回落到默认秒数，不出现 undefined。
    const fallback = factoryResult.__test.DownloadsList({
      view,
      currentVersion: '0.2.2-rc.3',
      onSwitch() {},
      onPurge() {},
      onCancelSwitch() {},
      switchBusy: undefined,
      purgeArm: '0.2.1-rc.5',
    });
    assert.match(textOf(fallback), /4 秒后自动取消/u);
    assert.ok(!textOf(fallback).includes('undefined'));
  });

  test('二次确认的文案键齐全（含秒数与取消提示）', () => {
    const dict = factoryResult.__test.DICT.zh;
    assert.match(dict['action.purgeConfirmHint'], /\{seconds\}/u);
    assert.match(dict['action.purgeCancelled'], /取消/u);
    assert.match(dict['toast.dismiss'], /关闭/u);
  });

  process.stdout.write(`\n${passed} passed\n`);
} catch (error) {
  process.stdout.write(`\n${passed} passed, then failed\n`);
  throw error;
}

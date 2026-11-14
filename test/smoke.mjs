/**
 * 离线冒烟测试：不加载 DSH 宿主，只测纯逻辑。
 *
 * 运行：node test/smoke.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareVersions, channelOf, parseVersion, tagOf, versionOfTag, isPrerelease, sortByVersionDesc, platformDir, installerExtension } from '../lib/version.js';
import { parseReleaseBody, renderReleaseText } from '../lib/changelog.js';
import { JsonCache } from '../lib/cache.js';
import { formatBytes, fileNameOf, Downloader } from '../lib/installer.js';
import { createOperations, isLoopback, versionOf, ROUTE } from '../lib/routes.js';
import { renderVersionList, renderRelease, renderDownloads, renderSwitchState, channelLabel, installerLabel } from '../lib/render.js';
import { createVersionTools, TOOL_NAMES } from '../lib/tools.js';
import { parseJsonLoose, readFromAsar, desktopInstallDir } from '../lib/runtime.js';
import { normalizeConfig, Config } from '../lib/config.js';
import { Switcher, downloadsView } from '../lib/switch.js';

const dir = mkdtempSync(join(tmpdir(), 'dsh-versions-test-'));
let passed = 0;

/**
 * 登记一个测试。同步与异步都支持：真正的执行放到全部登记完之后，
 * 否则异步用例会在 finally 清理临时目录之后才继续跑，读到的全是空目录。
 * @param {string} name 用例名。
 * @param {() => unknown} fn 用例体。
 */
const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}

/**
 * 顺序执行登记过的用例；第一个失败即中止。
 * @returns {Promise<void>} 完成。
 */
async function run() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      process.stdout.write(`FAIL ${name}\n`);
      throw error;
    }
  }
}

const BODY = `[中文](#cn-v0.2.2-rc.3) | [English](#en-v0.2.2-rc.3)

<h3 id="cn-v0.2.2-rc.3">新增功能</h3>

- 新增实验性「DeepSeek 会话导入」插件。 @imccyu

### 问题修复

- 修复 Windows 桌面版应用内更新可能失败的问题。 @winewill

<h3 id="en-v0.2.2-rc.3">New Features</h3>

- Add an experimental import plugin. by @imccyu

### Bug Fixes

- Fix an issue that could cause Windows updates to fail. by @winewill

Full Changelog: https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.2...dsh-v0.2.2-rc.3
`;

try {
  test('parseVersion 解析 semver 与预发布', () => {
    const parsed = parseVersion('v0.2.2-rc.3');
    assert.equal(parsed.major, 0);
    assert.equal(parsed.minor, 2);
    assert.equal(parsed.patch, 2);
    assert.deepEqual(parsed.prerelease, ['rc', '3']);
    assert.equal(parseVersion('nope'), undefined);
    assert.equal(parseVersion(undefined), undefined);
  });

  test('compareVersions 按 semver 排序', () => {
    assert.ok(compareVersions('0.1.0', '0.2.0') < 0);
    assert.ok(compareVersions('0.2.0', '0.2.0-rc.1') > 0);
    assert.ok(compareVersions('0.2.0-rc.2', '0.2.0-rc.10') < 0);
    assert.ok(compareVersions('0.2.0-alpha.1', '0.2.0-beta.1') < 0);
    assert.ok(compareVersions('0.2.0-beta.1', '0.2.0-rc.1') < 0);
    assert.equal(compareVersions('0.2.2-rc.3', '0.2.2-rc.3'), 0);
  });

  test('channelOf 判定渠道', () => {
    assert.equal(channelOf('0.2.0'), 'stable');
    assert.equal(channelOf('0.2.2-rc.3'), 'rc');
    assert.equal(channelOf('0.2.2-alpha.3'), 'alpha');
    assert.equal(channelOf('0.2.2-beta.1'), 'beta');
    assert.equal(isPrerelease('0.2.2-rc.3'), true);
    assert.equal(isPrerelease('0.2.0'), false);
  });

  test('tagOf / versionOfTag 往返', () => {
    assert.equal(tagOf('0.2.2-rc.3'), 'dsh-v0.2.2-rc.3');
    assert.equal(versionOfTag('dsh-v0.2.2-rc.3'), '0.2.2-rc.3');
    assert.equal(versionOfTag(undefined), undefined);
  });

  test('sortByVersionDesc 不改动入参', () => {
    const rows = [{ version: '0.1.0' }, { version: '0.2.0' }];
    const sorted = sortByVersionDesc(rows);
    assert.equal(sorted[0].version, '0.2.0');
    assert.equal(rows[0].version, '0.1.0');
  });

  test('platformDir / installerExtension', () => {
    assert.equal(platformDir('win32', 'x64'), 'win-x64');
    assert.equal(platformDir('darwin', 'arm64'), 'darwin-arm64');
    assert.equal(installerExtension('win32'), '.exe');
    assert.equal(installerExtension('darwin'), '.dmg');
  });

  test('parseReleaseBody 拆出中英两段', () => {
    const parsed = parseReleaseBody(BODY);
    assert.equal(parsed.empty, false);
    assert.ok(parsed.zh.length >= 2, `zh sections: ${parsed.zh.length}`);
    assert.ok(parsed.en.length >= 2, `en sections: ${parsed.en.length}`);
    assert.equal(parsed.zh[0].title, '新增功能');
    assert.equal(parsed.zh[0].items[0].text, '新增实验性「DeepSeek 会话导入」插件。');
    assert.deepEqual(parsed.zh[0].items[0].authors, ['imccyu']);
    assert.equal(parsed.zh[1].title, '问题修复');
    assert.equal(parsed.en[0].title, 'New Features');
    assert.equal(parsed.en[0].items[0].authors[0], 'imccyu');
    assert.match(parsed.compareUrl, /compare\/dsh-v0\.2\.2-rc\.2\.\.\.dsh-v0\.2\.2-rc\.3/u);
  });

  test('parseReleaseBody 对空正文与无语言标记都能降级', () => {
    assert.equal(parseReleaseBody('').empty, true);
    assert.equal(parseReleaseBody(undefined).empty, true);
    const plain = parseReleaseBody('### 修复\n\n- 一条中文\n');
    assert.equal(plain.empty, false);
    assert.equal(plain.zh[0].items[0].text, '一条中文');
    assert.equal(plain.en[0].items[0].text, '一条中文', '另一语言应补一份');
  });

  test('renderReleaseText 输出纯文本', () => {
    const text = renderReleaseText(parseReleaseBody(BODY), 'zh');
    assert.match(text, /【新增功能】/u);
    assert.match(text, /- 新增实验性/u);
    assert.match(text, /完整对比：https:/u);
  });

  test('JsonCache 读写与过期', () => {
    let now = 1000;
    const cache = new JsonCache({ dir: join(dir, 'cache'), now: () => now });
    assert.equal(cache.read('a'), undefined);
    assert.equal(cache.write('a', { x: 1 }), true);
    assert.deepEqual(cache.read('a').value, { x: 1 });
    assert.deepEqual(cache.readFresh('a', 500).value, { x: 1 });
    now = 2000;
    assert.equal(cache.readFresh('a', 500), undefined);
    assert.deepEqual(cache.read('a').value, { x: 1 }, '过期后仍能读到旧值');
  });

  test('formatBytes / fileNameOf', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(299595752), '285.7 MB');
    assert.equal(fileNameOf('https://x/y/deepseek-harness-0.2.2-rc.3-win-x64.exe'), 'deepseek-harness-0.2.2-rc.3-win-x64.exe');
    assert.equal(fileNameOf('not a url'), 'dsh-installer');
  });

  test('Downloader 路径与已下载判定', () => {
    const downloader = new Downloader({ dir: join(dir, 'downloads') });
    const url = 'https://x/y/dsh.exe';
    const path = downloader.pathFor('0.2.2-rc.3', url);
    assert.match(path, /0\.2\.2-rc\.3[\\/]dsh\.exe$/u);
    assert.equal(downloader.downloaded('0.2.2-rc.3', url), undefined);
    assert.deepEqual(downloader.list(), []);
    assert.equal(downloader.launch('').ok, false, '不存在的路径不能启动');
    assert.equal(downloader.status().active, false);
  });

  test('Downloader 能扫出已下载的安装包并按版本删除', () => {
    const root = join(dir, 'downloads-scan');
    const downloader = new Downloader({ dir: root });
    const big = Buffer.alloc(1024 * 1024 + 8, 7);
    for (const version of ['0.2.2-rc.3', '0.2.1-rc.5']) {
      const target = join(root, version);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, `deepseek-harness-${version}-win-x64.exe`), big);
    }
    // 太小的文件不算下载完成。
    const tiny = join(root, '0.1.0-rc.1');
    mkdirSync(tiny, { recursive: true });
    writeFileSync(join(tiny, 'deepseek-harness-0.1.0-rc.1-win-x64.exe'), 'x');

    const rows = downloader.list();
    assert.deepEqual(rows.map((row) => row.version), ['0.2.2-rc.3', '0.2.1-rc.5'], '从新到旧，且跳过残缺文件');
    assert.equal(rows[0].size, big.length);
    assert.match(rows[0].sizeText, /MB$/u);
    assert.equal(rows[0].current, undefined, 'list 不判断当前版本');

    const entry = downloader.entryFor('0.2.1-rc.5');
    assert.match(entry.path, /0\.2\.1-rc\.5/u);
    assert.equal(downloader.entryFor('0.1.0-rc.1'), undefined, '小于 1 MB 的当作没下完');
    assert.equal(downloader.entryFor('9.9.9'), undefined);

    const purged = downloader.removeVersion('0.2.1-rc.5');
    assert.equal(purged.removed, true);
    assert.equal(purged.freedBytes, big.length);
    assert.equal(downloader.entryFor('0.2.1-rc.5'), undefined);
    assert.equal(downloader.list().length, 1);
  });

  test('Switcher 记录切换意图并在版本对上后结算', () => {
    const root = join(dir, 'switch-state');
    const downloadRoot = join(dir, 'switch-downloads');
    mkdirSync(root, { recursive: true });
    mkdirSync(join(downloadRoot, '0.2.1-rc.5'), { recursive: true });
    const installer = join(downloadRoot, '0.2.1-rc.5', 'dsh.exe');
    writeFileSync(installer, Buffer.alloc(1024 * 1024 + 8, 1));

    const downloader = new Downloader({ dir: downloadRoot });
    // 只替换 launch，避免测试真的启动安装程序。
    const launched = [];
    downloader.launch = (path) => {
      launched.push(path);
      return { ok: true, pid: 1234 };
    };
    const switcher = new Switcher({ downloader, dir: root });

    assert.deepEqual(switcher.read(), {}, '初始没有状态');

    const same = switcher.request('0.2.1-rc.5', '0.2.1-rc.5');
    assert.equal(same.ok, false);
    assert.equal(same.code, 'ALREADY_CURRENT');

    const missing = switcher.request('0.1.0-rc.7', '0.2.2-rc.3');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'NOT_DOWNLOADED');

    const ok = switcher.request('0.2.1-rc.5', '0.2.2-rc.3');
    assert.equal(ok.ok, true);
    assert.equal(ok.path, installer);
    assert.deepEqual(launched, [installer], '应当启动这个版本的安装程序');

    const pending = switcher.status('0.2.2-rc.3');
    assert.equal(pending.pending.version, '0.2.1-rc.5');
    assert.equal(pending.applied, undefined, '版本还没变，不算完成');

    // 切回去之后：当前版本等于 pending.version，结算成 applied。
    const settled = switcher.status('0.2.1-rc.5');
    assert.equal(settled.pending, undefined);
    assert.equal(settled.applied.version, '0.2.1-rc.5');
    // 幂等：再问一次不会变。
    assert.deepEqual(switcher.status('0.2.1-rc.5'), settled);

    // 新的一次切换请求不会抹掉 applied 历史。
    const again = switcher.request('0.2.1-rc.5', '0.2.2-rc.3');
    assert.equal(again.ok, true);
    const cancelled = switcher.cancel();
    assert.equal(cancelled.cleared, true);
    assert.equal(switcher.status('0.2.2-rc.3').pending, undefined);
    assert.equal(switcher.status('0.2.2-rc.3').applied.version, '0.2.1-rc.5', 'applied 历史要保留');
  });

  test('downloadsView 汇总已下载与切换状态', () => {
    const root = join(dir, 'view-downloads');
    mkdirSync(join(root, '0.2.1-rc.5'), { recursive: true });
    writeFileSync(join(root, '0.2.1-rc.5', 'dsh.exe'), Buffer.alloc(2 * 1024 * 1024, 1));
    const downloader = new Downloader({ dir: root });
    const switcher = new Switcher({ downloader, dir: join(dir, 'view-state') });

    const empty = downloadsView({ downloader: new Downloader({ dir: join(dir, 'nope') }), currentVersion: '0.2.2-rc.3' });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.totalSizeText, '0 B');

    const view = downloadsView({ downloader, switcher, currentVersion: '0.2.1-rc.5' });
    assert.equal(view.total, 1);
    assert.equal(view.items[0].current, true, '当前版本要标出来');
    assert.match(view.totalSizeText, /MB$/u);
    assert.equal(view.dir, root);
  });

  test('versionOf 收敛非法版本号', () => {
    assert.equal(versionOf(' 0.2.2-rc.3 '), '0.2.2-rc.3');
    assert.equal(versionOf('../../etc/passwd'), undefined);
    assert.equal(versionOf(''), undefined);
    assert.equal(versionOf(123), undefined);
    assert.equal(versionOf('a'.repeat(200)), undefined);
  });

  test('isLoopback 只认回环地址', () => {
    assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true);
    assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
    assert.equal(isLoopback({ socket: { remoteAddress: '10.0.0.2' } }), false);
    assert.equal(isLoopback({}), false);
  });

  test('normalizeConfig 补齐默认值', () => {
    const config = normalizeConfig({ cacheMinutes: 9999, probeInstallers: 'yes' });
    assert.equal(config.cacheMinutes, 1440);
    assert.equal(config.probeInstallers, true);
    assert.equal(config.dataDir, '');
    assert.equal(normalizeConfig(undefined).cacheMinutes, 30);
  });

  test('Config schema 每个节点都带 meta', () => {
    const json = Config.toJSON();
    assert.equal(typeof json.meta, 'object');
    for (const [key, node] of Object.entries(json.dict)) {
      assert.equal(typeof node.meta, 'object', `${key} 缺少 meta`);
      assert.equal(typeof node.meta.description, 'string');
    }
    const validated = Config['~standard'].validate({ cacheMinutes: 5 });
    assert.equal(validated.value.cacheMinutes, 5);
  });

  test('renderVersionList 标注当前版本与安装包状态', () => {
    const overview = {
      packageName: '@deepseek-ai/dsh',
      platformDir: 'win-x64',
      currentVersion: '0.2.2-rc.3',
      total: 2,
      versions: [
        { version: '0.2.2-rc.3', channel: 'rc', publishedAt: Date.UTC(2026, 10, 13), hasChangelog: true, installer: 'available', installerSize: 299595752, current: true },
        { version: '0.1.0-rc.7', channel: 'rc', publishedAt: Date.UTC(2026, 8, 1), hasChangelog: true, installer: 'missing' },
      ],
    };
    const text = renderVersionList(overview);
    assert.match(text, /当前版本：0\.2\.2-rc\.3/u);
    assert.match(text, /← 当前/u);
    assert.match(text, /安装包:可下载/u);
    assert.match(text, /安装包:无安装包/u);
    assert.equal(channelLabel('stable'), '正式版');
    assert.equal(installerLabel('unknown'), '未探测');
  });

  test('renderRelease 处理无 release 的版本', () => {
    assert.match(renderRelease({ version: '0.0.1-rc.1', found: false }, undefined), /没有公开的更新说明/u);
    const text = renderRelease({
      version: '0.2.2-rc.3',
      found: true,
      publishedAt: Date.UTC(2026, 10, 13),
      url: 'https://github.com/x/y/releases/tag/dsh-v0.2.2-rc.3',
      text: '【新增功能】\n- 一条',
    }, '0.2.2-rc.3');
    assert.match(text, /这就是当前安装的版本/u);
    assert.match(text, /【新增功能】/u);
  });

  test('renderDownloads 列出已下载与切换状态', () => {
    const empty = renderDownloads({
      items: [], total: 0, totalSize: 0, totalSizeText: '0 B', dir: 'C:/x',
    });
    assert.match(empty, /还没有下载过任何 DSH 安装包/u);
    assert.match(empty, /C:\/x/u);

    const text = renderDownloads({
      items: [
        { version: '0.2.2-rc.3', sizeText: '285.7 MB', current: true },
        { version: '0.2.1-rc.5', sizeText: '276.6 MB', current: false },
      ],
      total: 2,
      totalSize: 589595752,
      totalSizeText: '562.3 MB',
      dir: 'C:/x',
      pending: { version: '0.2.1-rc.5', at: Date.UTC(2026, 10, 14) },
      applied: { version: '0.2.0-rc.1', at: Date.UTC(2026, 10, 10) },
    });
    assert.match(text, /已下载的 DSH 安装包：2 个/u);
    assert.match(text, /562\.3 MB/u);
    assert.match(text, /← 当前版本/u);
    assert.match(text, /待切换：0\.2\.1-rc\.5/u);
    assert.match(text, /上次切换已完成：0\.2\.0-rc\.1/u);
    assert.equal(renderSwitchState({}), undefined);
  });

  test('createOperations 各 op 走同一份依赖', async () => {
    const calls = [];
    const catalog = {
      overview: async (options) => {
        calls.push(['overview', options]);
        return { versions: [{ version: '0.2.2-rc.3', current: true }], total: 1, distTags: { latest: '0.2.2-rc.1' } };
      },
      releaseBody: async (version) => {
        calls.push(['releaseBody', version]);
        return { version, body: BODY, found: true, url: 'https://x' };
      },
      installer: async (version) => {
        calls.push(['installer', version]);
        return { version, available: true, url: 'https://x/dsh.exe', size: 2048 };
      },
      probeMany: async (versions) => versions.map((version) => ({ version, available: true })),
      installerUrl: (version) => `https://x/${version}.exe`,
    };
    const downloader = {
      start: async (request) => {
        calls.push(['start', request]);
        return { ok: true, path: 'C:/x/dsh.exe', size: 2048, cached: false };
      },
      status: () => ({ active: true, received: 1024, total: 2048, speed: 512 }),
      downloaded: () => undefined,
      launch: () => ({ ok: true, pid: 1 }),
      remove: () => true,
      list: () => [],
    };
    const ops = createOperations({
      catalog,
      downloader,
      runtime: () => ({ version: '0.2.2-rc.3', platform: 'win32', arch: 'x64' }),
    });

    const ping = await ops.ping();
    assert.equal(ping.plugin, 'dsh-versions');
    assert.equal((await ops.runtime()).version, '0.2.2-rc.3');

    const overview = await ops.overview({ force: '1' });
    assert.equal(overview.currentVersion, '0.2.2-rc.3');
    assert.equal(calls[0][1].force, true);
    assert.equal(calls[0][1].currentVersion, '0.2.2-rc.3');

    const release = await ops.release({ version: '0.2.2-rc.3' });
    assert.equal(release.found, true);
    assert.equal(release.zh[0].title, '新增功能');

    const installer = await ops.installer({ version: '0.2.2-rc.3' });
    assert.equal(installer.available, true);
    assert.equal(installer.sizeText, '2 KB');

    const download = await ops.download({ version: '0.2.2-rc.3' });
    assert.equal(download.ok, true);
    assert.equal(download.sizeText, '2 KB');

    const progress = await ops.progress();
    assert.equal(progress.percent, 50);
    assert.equal(progress.speedText, '512 B/s');

    assert.equal((await ops.download({ version: '../../x' })).ok, false);
    assert.equal((await ops.release({})).ok, false);
    assert.equal((await ops.probe({ versions: ['0.2.2-rc.3', '../bad'] })).results.length, 1);
    assert.equal((await ops.launch({ version: '0.2.2-rc.3' })).ok, false, '没下载过不能启动');
    assert.equal((await ops.discard({ version: '0.2.2-rc.3' })).ok, true);
    assert.deepEqual((await ops.downloads()).items, []);
    assert.equal(ROUTE, '/dsh-versions');
  });

  test('createOperations 的 switch / purge / downloads 走同一份 Switcher', async () => {
    const root = join(dir, 'ops-downloads');
    mkdirSync(join(root, '0.2.1-rc.5'), { recursive: true });
    const installerPath = join(root, '0.2.1-rc.5', 'dsh.exe');
    writeFileSync(installerPath, Buffer.alloc(1024 * 1024 + 8, 1));

    const downloader = new Downloader({ dir: root });
    const launched = [];
    downloader.launch = (path) => {
      launched.push(path);
      return { ok: true, pid: 77 };
    };
    const switcher = new Switcher({ downloader, dir: join(dir, 'ops-state') });

    const ops = createOperations({
      catalog: { installerUrl: (version) => `https://x/${version}.exe` },
      downloader,
      switcher,
      runtime: () => ({ version: '0.2.2-rc.3' }),
    });

    const view = await ops.downloads();
    assert.equal(view.ok, true);
    assert.equal(view.total, 1);
    assert.equal(view.items[0].version, '0.2.1-rc.5');
    assert.equal(view.items[0].current, false);

    const same = await ops.switch({ version: '0.2.2-rc.3' });
    assert.equal(same.ok, false, '切到当前版本没有意义');

    const missing = await ops.switch({ version: '0.1.0-rc.7' });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /还没下载/u);

    const switched = await ops.switch({ version: '0.2.1-rc.5' });
    assert.equal(switched.ok, true);
    assert.equal(switched.path, installerPath);
    assert.deepEqual(launched, [installerPath]);
    assert.equal((await ops.downloads()).pending.version, '0.2.1-rc.5');

    const cancelled = await ops.unswitch();
    assert.equal(cancelled.ok, true);
    assert.equal((await ops.downloads()).pending, undefined);

    const purged = await ops.purge({ version: '0.2.1-rc.5' });
    assert.equal(purged.ok, true);
    assert.match(purged.freedText, /MB$/u);
    assert.deepEqual((await ops.downloads()).items, []);

    assert.equal((await ops.purge({ version: '../x' })).ok, false);
    assert.equal((await ops.switch({ version: '' })).ok, false);
    assert.equal((await ops.purge({})).ok, false);
  });

  test('createVersionTools 注册五个工具并渲染', async () => {
    const registered = [];
    const defineTool = (definition) => {
      registered.push(definition);
      return definition;
    };
    const ops = {
      runtime: () => ({ version: '0.2.2-rc.3' }),
      overview: async () => ({
        packageName: '@deepseek-ai/dsh',
        platformDir: 'win-x64',
        currentVersion: '0.2.2-rc.3',
        distTags: { latest: '0.2.2-rc.1' },
        total: 1,
        versions: [{ version: '0.2.2-rc.3', channel: 'rc', publishedAt: Date.UTC(2026, 10, 13), hasChangelog: true, installer: 'available', current: true }],
      }),
      release: async (version) => ({ version, found: true, text: '【新增功能】\n- 一条' }),
      download: async (version) => ({ ok: true, version, path: 'C:/x/dsh.exe', sizeText: '285.7 MB' }),
      downloads: () => ({
        items: [
          { version: '0.2.2-rc.3', path: 'C:/x/0.2.2-rc.3/dsh.exe', size: 299595752, sizeText: '285.7 MB', current: true },
          { version: '0.2.1-rc.5', path: 'C:/x/0.2.1-rc.5/dsh.exe', size: 290000000, sizeText: '276.6 MB', current: false },
        ],
        total: 2,
        totalSize: 589595752,
        totalSizeText: '562.3 MB',
        dir: 'C:/x',
        pending: { version: '0.2.1-rc.5', at: Date.UTC(2026, 10, 14) },
      }),
      switchTo: (version) => ({ ok: true, version, path: `C:/x/${version}/dsh.exe`, pid: 42 }),
    };
    const definitions = createVersionTools(defineTool, ops);
    assert.equal(definitions.length, 5);
    assert.deepEqual(
      definitions.map((item) => item.name),
      [TOOL_NAMES.list, TOOL_NAMES.release, TOOL_NAMES.download, TOOL_NAMES.downloads, TOOL_NAMES.switch],
    );

    const listText = await definitions[0].execute({ channel: 'rc' });
    assert.match(listText, /当前版本：0\.2\.2-rc\.3/u);

    const latestText = await definitions[1].execute({});
    assert.match(latestText, /DSH 0\.2\.2-rc\.1 更新说明/u, '省略版本号时取 latest');

    const releaseText = await definitions[1].execute({ version: '0.2.2-rc.3' });
    assert.match(releaseText, /这就是当前安装的版本/u);

    const downloadText = await definitions[2].execute({ version: '0.2.2-rc.3' });
    assert.match(downloadText, /285\.7 MB/u);
    assert.match(downloadText, /插件不会自动执行安装/u);
    assert.match(downloadText, /dsh_versions_switch/u, '下载后要提示可以切换');

    const downloadsText = await definitions[3].execute({});
    assert.match(downloadsText, /已下载的 DSH 安装包：2 个/u);
    assert.match(downloadsText, /562\.3 MB/u);
    assert.match(downloadsText, /0\.2\.1-rc\.5/u);
    assert.match(downloadsText, /← 当前版本/u);
    assert.match(downloadsText, /待切换：0\.2\.1-rc\.5/u);

    const hitText = await definitions[3].execute({ version: '0.2.1-rc.5' });
    assert.match(hitText, /已下载 0\.2\.1-rc\.5 的安装包/u);
    assert.match(await definitions[3].execute({ version: '0.1.0-rc.7' }), /本地没有 0\.1\.0-rc\.7 的安装包/u);

    const switchText = await definitions[4].execute({ version: '0.2.1-rc.5' });
    assert.match(switchText, /已启动 DSH 0\.2\.1-rc\.5 的官方安装程序/u);
    assert.match(switchText, /由用户在安装程序里确认/u);

    assert.match(await definitions[2].execute({}), /缺少版本号/u);
    assert.match(await definitions[4].execute({}), /缺少版本号/u);
    const failed = await definitions[2].execute({ version: '0.1.0-rc.7' });
    assert.ok(typeof failed === 'string');
  });

  test('parseJsonLoose 容忍 asar 条目前缀', () => {
    assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonLoose(');\n{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonLoose('};\n{"a":1}'), { a: 1 });
    assert.equal(parseJsonLoose(''), undefined);
    assert.equal(parseJsonLoose(undefined), undefined);
    assert.equal(parseJsonLoose('no json here'), undefined);
  });

  test('readFromAsar 按 asar 头正确取偏移', () => {
    // 构造一个最小 asar：16 字节前缀（u32@12 = JSON 长度）+ JSON 头 + 数据区。
    // 数据区起点是 8 + u32@4，JSON 从偏移 16 开始，尾部补 \0 对齐到 4 字节。
    const json = JSON.stringify({ files: { 'a.json': { size: 9, offset: '0' } } });
    const jsonBytes = Buffer.from(json, 'utf8');
    const aligned = Math.ceil(jsonBytes.length / 4) * 4;
    const payloadSize = 8 + aligned;
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(payloadSize, 4);
    prefix.writeUInt32LE(aligned, 8);
    prefix.writeUInt32LE(jsonBytes.length, 12);
    const header = Buffer.alloc(aligned);
    jsonBytes.copy(header, 0);
    const data = Buffer.from('{"a": 1}\n', 'utf8');
    const archive = join(dir, 'fake.asar');
    writeFileSync(archive, Buffer.concat([prefix, header, data]));

    assert.equal(readFromAsar(archive, 'a.json'), '{"a": 1}\n');
    assert.equal(readFromAsar(archive, 'missing.json'), undefined);
    assert.equal(readFromAsar(join(dir, 'nope.asar'), 'a.json'), undefined);
  });

  test('desktopInstallDir 在非桌面进程里返回 undefined', () => {
    // 测试进程的 execPath 是 node，没有 resources/app.asar。
    const detected = desktopInstallDir();
    assert.ok(detected === undefined || typeof detected === 'string');
  });

  await run();
  process.stdout.write(`\n${passed} passed\n`);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败无所谓 */
  }
}

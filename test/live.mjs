/**
 * 联网自检：真打 npm registry / GitHub API / 下载站，验证目录与解析。
 * 只在开发时手动跑：node test/live.mjs
 */

import { Catalog } from '../lib/catalog.js';
import { detectCurrentVersion, updateChannel, desktopInstallDir, desktopShellVersion } from '../lib/runtime.js';
import { parseReleaseBody, renderReleaseText } from '../lib/changelog.js';
import { defaultDataDir } from '../lib/paths.js';

const dir = defaultDataDir();
process.stdout.write(`data dir: ${dir}\n`);

process.stdout.write('\n--- runtime ---\n');
const detected = detectCurrentVersion();
process.stdout.write(`${JSON.stringify(detected, null, 2)}\n`);
process.stdout.write(`desktopInstallDir: ${desktopInstallDir()}\n`);
process.stdout.write(`shell: ${desktopShellVersion()}\n`);
process.stdout.write(`channel: ${JSON.stringify(updateChannel())}\n`);

const catalog = new Catalog({ dir, logger: console });

process.stdout.write('\n--- npm versions ---\n');
const npm = await catalog.npmVersions({ force: true });
process.stdout.write(`count=${npm.versions.length} stale=${npm.stale} error=${npm.error}\n`);
process.stdout.write(`tags=${JSON.stringify(npm.tags)}\n`);
for (const row of npm.versions.slice(0, 5)) {
  process.stdout.write(`  ${row.version}  ${row.publishedAt === undefined ? '—' : new Date(row.publishedAt).toISOString()}\n`);
}

process.stdout.write('\n--- releases ---\n');
const gh = await catalog.releases({ force: true });
process.stdout.write(`count=${gh.releases.length} stale=${gh.stale} error=${gh.error}\n`);
for (const row of gh.releases.slice(0, 3)) process.stdout.write(`  ${row.version} body=${row.body.length}\n`);

const target = '0.2.2-rc.3';
process.stdout.write(`\n--- release ${target} ---\n`);
const release = await catalog.releaseBody(target, { force: true });
process.stdout.write(`found=${release.found} body=${release.body.length}\n`);
const parsed = parseReleaseBody(release.body);
process.stdout.write(`zh sections=${parsed.zh.length} en sections=${parsed.en.length} compare=${parsed.compareUrl}\n`);
process.stdout.write(`${renderReleaseText(parsed, 'zh').slice(0, 600)}\n`);

process.stdout.write('\n--- installer probe ---\n');
for (const version of ['0.2.2-rc.3', '0.2.1-rc.5', '0.1.0-rc.7']) {
  const probe = await catalog.installer(version, { force: true });
  process.stdout.write(`  ${version}: available=${probe.available} size=${probe.size} status=${probe.status} error=${probe.error}\n`);
}

process.stdout.write('\n--- overview ---\n');
const overview = await catalog.overview({ force: true, currentVersion: detected.version });
process.stdout.write(`total=${overview.total} withChangelog=${overview.withChangelog} stale=${overview.stale}\n`);
for (const row of overview.versions.slice(0, 6)) {
  process.stdout.write(`  ${row.version} ch=${row.channel} pub=${row.publishedAt === undefined ? '—' : new Date(row.publishedAt).toISOString().slice(0, 10)} log=${row.hasChangelog} ins=${row.installer} cur=${row.current}\n`);
}

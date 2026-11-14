/**
 * 面板用的回环 HTTP 路由。
 *
 * 客户端面板 `fetch('/dsh-versions/api?op=…')`，与 Agent 工具共享同一份
 * Catalog / Downloader；这里只做参数校验与 JSON 包装。
 *
 * 只服务本机回环连接：远程连接直接 403（下载 300 MB 安装包不该被远程触发）。
 *
 * @module dsh-versions/routes
 */

import { parseReleaseBody, renderReleaseText } from './changelog.js';
import { formatBytes } from './installer.js';
import { downloadsView } from './switch.js';

/** 路由前缀。 */
export const ROUTE = '/dsh-versions';

/** 请求体上限。 */
const MAX_BODY_BYTES = 256 * 1024;

/** 版本号长度上限。 */
const MAX_VERSION_LENGTH = 64;

/**
 * 判断请求是否来自本机回环。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 是否回环。
 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== 'string') return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('127.');
}

/**
 * 读完整请求体。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {Promise<string>} 文本。
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {unknown} value 响应体。
 * @param {number} [status] HTTP 状态码。
 * @returns {void}
 */
export function sendJson(res, value, status = 200) {
  try {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch (error) {
    try {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    } catch {
      /* 响应已断开 */
    }
  }
}

/**
 * 校验版本号参数。
 * @param {unknown} value 输入。
 * @returns {string|undefined} 合法版本号。
 */
export function versionOf(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '' || text.length > MAX_VERSION_LENGTH) return undefined;
  return /^[0-9A-Za-z.+-]+$/u.test(text) ? text : undefined;
}

/**
 * 面板操作表。
 * @param {{catalog: object, downloader: object, switcher?: object, runtime: () => object}} deps 依赖。
 * @returns {Record<string, (payload: object) => Promise<object>|object>} op → 处理函数。
 */
export function createOperations(deps) {
  const { catalog, downloader, runtime, switcher } = deps;
  const fail = (error) => ({ ok: false, error });

  return {
    ping() {
      return { ok: true, plugin: 'dsh-versions', version: 1 };
    },

    /** 运行时信息：当前版本、平台、更新通道。 */
    runtime() {
      return { ok: true, ...runtime() };
    },

    /** 版本目录（npm 版本 + 更新说明有无 + 安装包可用性缓存）。 */
    async overview(payload) {
      const info = runtime();
      const data = await catalog.overview({
        force: payload?.force === '1' || payload?.force === true,
        currentVersion: info.version,
      });
      return { ok: true, ...data, currentVersion: info.version, runtime: info };
    },

    /** 单个版本的更新说明（解析成中英两段）。 */
    async release(payload) {
      const version = versionOf(payload?.version);
      if (version === undefined) return fail('缺少合法的 version');
      const info = await catalog.releaseBody(version, {
        force: payload?.force === '1' || payload?.force === true,
      });
      const parsed = parseReleaseBody(info.body);
      return {
        ok: true,
        version,
        found: info.found === true,
        url: info.url,
        publishedAt: info.publishedAt,
        compareUrl: parsed.compareUrl,
        zh: parsed.zh,
        en: parsed.en,
        text: renderReleaseText(parsed, 'zh'),
        empty: parsed.empty,
        error: info.error,
      };
    },

    /** 探测安装包是否可下载。 */
    async installer(payload) {
      const version = versionOf(payload?.version);
      if (version === undefined) return fail('缺少合法的 version');
      const result = await catalog.installer(version, {
        force: payload?.force === '1' || payload?.force === true,
      });
      return { ok: true, ...result, sizeText: result.size === undefined ? undefined : formatBytes(result.size) };
    },

    /** 批量探测（限 24 个，避免把下载站打爆）。 */
    async probe(payload) {
      const versions = Array.isArray(payload?.versions)
        ? payload.versions.map(versionOf).filter((value) => value !== undefined)
        : [];
      if (versions.length === 0) return fail('缺少 versions');
      const results = await catalog.probeMany(versions);
      return { ok: true, results };
    },

    /** 开始下载安装包。 */
    async download(payload) {
      const version = versionOf(payload?.version);
      if (version === undefined) return fail('缺少合法的 version');
      const probe = await catalog.installer(version);
      if (probe.available !== true) {
        return fail(`该版本没有可用的官方安装包（${version}）`);
      }
      const result = await downloader.start({
        version,
        url: probe.url,
        expectedSize: probe.size,
      });
      if (result.ok !== true) return fail(result.error ?? '下载失败');
      return {
        ok: true,
        version,
        path: result.path,
        size: result.size,
        sizeText: formatBytes(result.size),
        cached: result.cached === true,
      };
    },

    /** 下载进度（面板轮询）。 */
    progress() {
      const status = downloader.status();
      const total = Number(status.total);
      const received = Number(status.received);
      const percent = status.percent !== undefined
        ? status.percent
        : Number.isFinite(total) && total > 0 && Number.isFinite(received)
          ? Math.min(100, (received / total) * 100)
          : undefined;
      return {
        ok: true,
        ...status,
        percent,
        sizeText: total > 0 ? formatBytes(total) : undefined,
        receivedText: received > 0 ? formatBytes(received) : undefined,
        speedText: status.speed > 0 ? `${formatBytes(status.speed)}/s` : undefined,
      };
    },

    /** 启动已下载的安装包。 */
    launch(payload) {
      const version = versionOf(payload?.version);
      if (version === undefined) return fail('缺少合法的 version');
      const url = catalog.installerUrl(version);
      const existing = downloader.downloaded(version, url);
      if (existing === undefined) return fail('安装包还没下载完，请先下载');
      const result = downloader.launch(existing.path);
      if (result.ok !== true) return fail(result.error ?? '无法启动安装程序');
      return { ok: true, version, path: existing.path, pid: result.pid };
    },

    /** 删除已下载的安装包。 */
    discard(payload) {
      const version = versionOf(payload?.version);
      if (version === undefined) return fail('缺少合法的 version');
      const removed = downloader.remove(version, catalog.installerUrl(version));
      return { ok: true, removed };
    },

    /** 下载目录里已有的安装包（含切换状态）。 */
    downloads() {
      return { ok: true, ...downloadsView({ downloader, switcher, currentVersion: runtime().version }) };
    },

    /** 删掉某个版本的全部下载（整目录，连带残留的 .part）。 */
    purge(payload) {
      const version = versionOf(payload?.version);
      if (version === undefined) return fail('缺少合法的 version');
      const result = downloader.removeVersion(version);
      if (result.removed !== true) return fail(`删除 ${version} 的安装包失败`);
      return {
        ok: true,
        version,
        freedBytes: result.freedBytes,
        freedText: formatBytes(result.freedBytes),
      };
    },

    /** 请求切换到某个已下载的版本：后台关掉 DSH、跑安装程序、再拉起来。 */
    async switch(payload) {
      const version = versionOf(payload?.version);
      if (version === undefined) return fail('缺少合法的 version');
      if (switcher === undefined) return fail('切换功能未启用');
      const info = runtime();
      const result = await switcher.request(version, info.version);
      if (result.ok !== true) {
        const messages = {
          ALREADY_CURRENT: `当前已经在运行 ${version}`,
          NOT_DOWNLOADED: `还没下载 ${version} 的安装包，请先下载`,
          NO_INSTALL_DIR: result.error ?? '认不出当前 DSH 的安装目录，无法自动切换',
          LAUNCH_FAILED: result.error ?? '无法启动后台更新任务',
        };
        return fail(messages[result.code] ?? result.error ?? '切换失败');
      }
      return {
        ok: true,
        version,
        path: result.path,
        pid: result.pid,
        logPath: result.logPath,
        pending: switcher.read().pending,
      };
    },

    /** 后台更新任务的日志尾巴（排查切换失败用）。 */
    log() {
      if (switcher === undefined) return fail('切换功能未启用');
      const tail = switcher.log(40);
      return { ok: true, path: tail.path, exists: tail.exists, text: tail.text };
    },

    /** 取消待切换标记（用户关掉了安装程序）。 */
    unswitch() {
      if (switcher === undefined) return fail('切换功能未启用');
      const result = switcher.cancel();
      return { ok: true, cleared: result.cleared };
    },
  };
}

/**
 * 挂载回环路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx 已注入 webServer 的上下文。
 * @param {{catalog: object, downloader: object, switcher?: object, runtime: () => object, logger?: object}} options 选项。
 * @returns {void}
 */
export function mountRoutes(ctx, options) {
  const webServer = ctx?.webServer ?? ctx?.get?.('webServer');
  if (webServer === undefined || typeof webServer.register !== 'function') {
    console.warn('[dsh-versions] webServer service missing; panel API disabled');
    return;
  }
  const operations = createOperations(options);
  const logger = options.logger;

  try {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        if (!isLoopback(req)) {
          sendJson(res, { ok: false, error: '仅支持本机回环访问' }, 403);
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) : '';
        try {
          if (req.method === 'GET') {
            const op = pathname === '/api' || pathname === '' ? url.searchParams.get('op') ?? 'ping' : pathname.replace(/^\//u, '');
            const handler = operations[op];
            if (handler === undefined) {
              sendJson(res, { ok: false, error: `未知操作 "${op}"` }, 404);
              return;
            }
            const payload = Object.fromEntries(url.searchParams.entries());
            const result = await handler(payload);
            sendJson(res, result, result.ok ? 200 : 400);
            return;
          }
          if (req.method === 'POST') {
            let body = {};
            const raw = await readBody(req);
            if (raw.trim() !== '') {
              try {
                body = JSON.parse(raw);
              } catch {
                sendJson(res, { ok: false, error: '无效的 JSON 请求体' }, 400);
                return;
              }
            }
            const op = typeof body?.op === 'string' ? body.op : pathname.replace(/^\//u, '');
            const handler = operations[op];
            if (handler === undefined) {
              sendJson(res, { ok: false, error: `未知操作 "${op}"` }, 404);
              return;
            }
            const result = await handler(body ?? {});
            sendJson(res, result, result.ok ? 200 : 400);
            return;
          }
          sendJson(res, { ok: false, error: '只支持 GET 与 POST' }, 405);
        } catch (error) {
          logger?.warn?.(`[dsh-versions] route error: ${error?.stack ?? error}`);
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    }), 'dsh-versions: panel routes');
  } catch (error) {
    logger?.warn?.(`[dsh-versions] could not mount panel routes: ${error?.message ?? error}`);
  }
}

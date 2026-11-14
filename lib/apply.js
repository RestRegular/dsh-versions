/**
 * 后台更新任务：把「切换版本」变成一次真正会自动跑完的动作。
 *
 * 旧实现只是把安装程序当子进程拉起来，可 DSH 还开着：安装程序要替换
 * \`DeepSeek Harness.exe\` 和 \`resources/**\`，文件被占用，于是要么弹「请先关闭
 * 应用」，要么装到一半失败 —— 用户看到的就是「点了切换没反应」。
 *
 * 现在分三步：
 *
 * 1. 往数据目录写 \`switch-request.json\`（版本、安装包、安装目录、日志路径）；
 * 2. 用 \`launch-apply.ps1\` 通过 WMI 的 \`Win32_Process.Create\` 把
 *    \`apply-switch.ps1\` 拉起来 —— 它的父进程是 WmiPrvSE，不在 DSH 的进程树里，
 *    所以 DSH 被杀掉之后 worker 照样活着（普通 detached spawn 仍可能被 Electron
 *    的 job object 连坐）；
 * 3. worker 先等 1.5 秒让界面收到响应，然后关掉正在运行的 DSH（先
 *    \`CloseMainWindow\`，超时再 \`Stop-Process -Force\`，顺带清掉安装目录里残留的
 *    子进程），等文件解锁后用 \`/S /currentuser /D=<安装目录>\` 静默安装；静默
 *    失败就退回可见安装程序，装完把新版本重新拉起来。
 *
 * 全程写进 \`apply-switch.log\`，面板和 Agent 工具都能把日志路径告诉用户。
 *
 * PowerShell 脚本刻意只写 ASCII：Windows PowerShell 5.1 读没有 BOM 的 .ps1 时按
 * 系统 ANSI 解码，塞中文进去会变乱码甚至语法错误。
 *
 * @module dsh-versions/apply
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** worker 脚本名（真正干活的）。 */
export const APPLY_SCRIPT = 'apply-switch.ps1';

/** 启动器脚本名（只负责把 worker 丢给 WMI，然后自己退出）。 */
export const LAUNCH_SCRIPT = 'launch-apply.ps1';

/** 本次切换的请求参数。 */
export const REQUEST_FILE = 'switch-request.json';

/** 启动器回写的启动结果（pid / 错误）。 */
export const LAUNCH_RESULT = 'apply-launch.json';

/** 后台任务日志。 */
export const LOG_FILE = 'apply-switch.log';

/** 脚本源目录（插件包内）。 */
const SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'scripts');

/**
 * 把 worker / 启动器脚本铺到数据目录（安装包位置固定，重复覆盖没有副作用）。
 *
 * 放在数据目录而不是直接从插件包里跑：插件装在 node_modules 里，路径可能带
 * 空格，也可能被热更新换掉；数据目录稳定，且和请求/日志挨在一起好排查。
 *
 * @param {string} dir 数据目录。
 * @returns {{workerPath: string, launcherPath: string}} 路径。
 */
export function writeScripts(dir) {
  mkdirSync(dir, { recursive: true });
  const workerPath = join(dir, APPLY_SCRIPT);
  const launcherPath = join(dir, LAUNCH_SCRIPT);
  copyFileSync(join(SCRIPT_SOURCE, APPLY_SCRIPT), workerPath);
  copyFileSync(join(SCRIPT_SOURCE, LAUNCH_SCRIPT), launcherPath);
  return { workerPath, launcherPath };
}

/**
 * 组装 worker 读的请求参数。
 * @param {{version: string, installerPath: string, installDir: string, exeFile: string, logPath: string, relaunch?: boolean, dryRun?: boolean}} options 参数。
 * @returns {object} 请求。
 */
export function buildRequest(options) {
  // NSIS 的 /D= 要的是 Windows 路径；顺手去掉尾部分隔符。
  const installDir = String(options.installDir ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '');
  const exeFile = String(options.exeFile ?? 'DeepSeek Harness.exe');
  return {
    version: options.version,
    installerPath: options.installerPath,
    installDir,
    installDirPrefix: installDir + '\\',
    exeFile,
    exeName: exeFile.replace(/\.exe$/iu, ''),
    logPath: options.logPath,
    relaunch: options.relaunch !== false,
    dryRun: options.dryRun === true,
    requestedAt: Date.now(),
  };
}

/**
 * 读启动器回写的结果。
 * @param {string} path 结果文件。
 * @returns {{ok: boolean, pid?: number, error?: string}} 结果。
 */
export function readLaunchResult(path) {
  try {
    // Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 会带 BOM，剥掉再解析。
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
    if (parsed !== null && typeof parsed === 'object' && parsed.ok === true) {
      const pid = Number(parsed.pid);
      return Number.isFinite(pid) && pid > 0 ? { ok: true, pid } : { ok: true };
    }
    return { ok: false, error: String(parsed?.error ?? '后台任务启动失败') };
  } catch (error) {
    return { ok: false, error: '后台任务启动失败：' + String(error?.message ?? error) };
  }
}

/**
 * 读后台任务的日志尾巴（面板/工具展示用）。
 * @param {string} dir 数据目录。
 * @param {number} [maxLines] 最多几行。
 * @returns {{path: string, exists: boolean, text: string}} 日志。
 */
export function readLog(dir, maxLines = 20) {
  const path = join(dir, LOG_FILE);
  if (!existsSync(path)) return { path, exists: false, text: '' };
  try {
    const lines = readFileSync(path, 'utf8')
      .replace(/^\uFEFF/u, '')
      .split(/\r?\n/u)
      .filter((line) => line !== '');
    return { path, exists: true, text: lines.slice(-maxLines).join('\n') };
  } catch {
    return { path, exists: true, text: '' };
  }
}

/**
 * 启动后台更新任务：写请求 → 拉起启动器 → 等启动器退出并回读 pid。
 *
 * 返回时 worker 已经在跑，但还没开始关 DSH（它先睡 1.5 秒），所以 HTTP 响应
 * 与界面提示能正常送达。
 *
 * @param {{dir: string, request: object, logger?: object, timeoutMs?: number}} options 选项。
 * @returns {Promise<{ok: boolean, pid?: number, logPath?: string, error?: string}>} 结果。
 */
export function launchApply(options) {
  const { dir, request, logger } = options;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20_000;
  try {
    const { launcherPath } = writeScripts(dir);
    const requestPath = join(dir, REQUEST_FILE);
    const resultPath = join(dir, LAUNCH_RESULT);
    writeFileSync(requestPath, JSON.stringify(request, null, 2), 'utf8');
    rmSync(resultPath, { force: true });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        launcherPath,
        '-RequestPath',
        requestPath,
      ], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => finish({ ok: false, error: '启动后台任务超时' }), timeoutMs);
      timer.unref?.();
      child.on('error', (error) => {
        clearTimeout(timer);
        logger?.warn?.('[dsh-versions] apply launcher failed: ' + String(error?.message ?? error));
        finish({ ok: false, error: String(error?.message ?? error) });
      });
      child.on('exit', () => {
        clearTimeout(timer);
        const result = readLaunchResult(resultPath);
        if (result.ok !== true) {
          logger?.warn?.('[dsh-versions] apply launcher returned: ' + result.error);
          finish(result);
          return;
        }
        finish({ ok: true, pid: result.pid, logPath: request.logPath });
      });
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    logger?.warn?.('[dsh-versions] could not start apply task: ' + message);
    return Promise.resolve({ ok: false, error: message });
  }
}

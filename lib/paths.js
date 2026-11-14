/**
 * 默认数据目录。
 *
 * 与其它 DSH 插件保持一致：`<DSH_HOME>/dsh-versions`，`DSH_HOME` 缺省为
 * `~/.dsh`。缓存与下载的安装包都放在这里，卸载插件不会自动删除（安装包
 * 有 300 MB，用户可能想留着复用）。
 *
 * @module dsh-versions/paths
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * DSH 家目录。
 * @returns {string} 路径。
 */
export function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return join(homedir(), '.dsh');
}

/**
 * 本插件的默认数据目录。
 * @returns {string} 路径。
 */
export function defaultDataDir() {
  return join(dshHome(), 'dsh-versions');
}

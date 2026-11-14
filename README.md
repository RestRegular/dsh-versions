# @restregular/dsh-versions

DSH 版本历史与更新说明面板 —— 看每个版本改了什么，并把想要的版本装回来。

DSH 的版本号迭代很快（44 个版本、几乎全是 `rc` / `alpha`），但版本之间的差异只
散落在 GitHub release 正文里，装回去还得自己去下载站翻。这个插件把四件事凑到一
起：**版本清单**、**双语更新说明**、**官方安装包下载**、**已下载版本管理与切换**。

## 功能

### 侧边栏「版本历史」页

- **版本清单**：44 个历史版本的版本号、发布渠道（正式版 / RC / Alpha / Beta）、
  发布日期，以及这个版本有没有更新说明。
- **当前版本高亮**：自动探测正在运行的 DSH 版本并在列表里标出，顶部单独显示。
- **安装包状态**：标出哪些版本在**当前平台**有官方安装包、多大；没有的明确标注
  「无安装包」，不会让用户点了才发现下载不到。
- **双语更新说明**：把 GitHub release 正文拆成中英两段，可以单独切换；条目里的
  作者署名（`@name`）单独弱化显示。
- **下载安装包**：点一下下载该版本的官方安装包（带进度条与速率）。
- **「已下载」页**：本地下过的所有版本排一列，带文件大小、合计占用、下载目录和
  「当前版本」标记。在这里可以**一键切换**到任意已下载的版本，也可以删掉占地方
  的旧安装包（二次确认，不会误删）。页头还会显示「待切换 / 上次切换已完成」。
- **切换是怎么做的**：直接启动那个版本的官方安装程序（和双击一样），装完重新打开
  DSH 就是新版本；插件只负责把安装包找出来并启动，**不静默替换文件、不替你关掉
  正在跑的 DSH**。启动后会在 `switch-state.json` 记下这次意图，等检测到当前版本
  变成目标版本时自动确认成「上次切换已完成」。

### 五个 Agent 工具

| 工具 | 用途 |
| --- | --- |
| `dsh_versions_list` | 列出版本清单（可按渠道过滤），带当前版本与安装包状态 |
| `dsh_versions_release` | 读某个版本的更新说明；省略版本号时取 npm 上的 `latest` |
| `dsh_versions_download` | 把指定版本的官方安装包下到本地，并告诉用户路径 |
| `dsh_versions_downloads` | 列本地已下载的安装包（大小、合计、哪个是当前版本、切换状态） |
| `dsh_versions_switch` | 切换到某个**已下载**的版本：启动它的官方安装程序并记录意图 |

插件还会把「当前 DSH 版本 · 更新通道」挂进运行时上下文，Agent 不必每次都去查。

## 为什么走官方安装包，而不是 `npm i -g`

用户明确说过「也可以不从 npm 下载」，而且这条路更稳：

- 桌面版的升级本来就走 `download.deepseek.com/dsh-desk/` 上的官方产物（和
  Electron 自动更新同一个分发源），装的是带签名的安装程序；
- 插件**不驱动 `autoUpdater`、不手改 `settings.json`**、不碰运行时目录 —— 那些
  都有日志与 schema 校验，绕过它们只会把环境搞坏；
- 「切换版本」也走这条路：启动对应版本的官方安装程序，等价于用户自己双击它；
- 下载完成后由用户自己双击安装，插件不会替你关掉正在跑的 DSH。

最后一步始终是用户的动作，插件只负责把安装包放到手边、并在你想换回去时帮你找到它。

## 数据来源与缓存

| 数据 | 来源 | 缓存 |
| --- | --- | --- |
| 版本号与发布日期 | `registry.npmjs.org/@deepseek-ai/dsh`（完整 packument） | 30 分钟（可配） |
| 更新说明 | `api.github.com/repos/deepseek-ai/deepseek-harness/releases`（tag `dsh-v<version>`） | 列表 30 分钟；单版本正文 7 天 |
| 安装包可用性 | `HEAD https://download.deepseek.com/dsh-desk/bin/<平台>/…` | 7 天 |

- 全部落盘在 `<DSH_HOME>/dsh-versions/`，写入走「临时文件 + rename」，不会留半个 JSON。
- 安装包按版本落在 `downloads/<version>/` 下；「已下载」页扫的就是这个目录。
- 切换状态记在 `switch-state.json`（`pending` / `applied` 两条）。
- 刷新失败时退回旧缓存，面板顶部提示「当前显示的是缓存数据」。
- GitHub 匿名限流 60 次/小时，所以**浏览器不发 GitHub 请求**，一律经宿主缓存。
- 设置 `GITHUB_TOKEN` / `GH_TOKEN` 环境变量可提高限额。

> 只有 `win-x64` 有安装包，且从 `0.1.7-rc.2` 起才有。更早的版本只能 npm 安装 ——
> 面板会如实标注，不会假装可下载。

## 安装

```bash
dsh plugin install @restregular/dsh-versions
```

或在插件管理器里装这个 bundle。装好后侧边栏出现「版本历史」入口。

## 设置

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `<DSH_HOME>/dsh-versions` | 缓存与安装包目录 |
| `cacheMinutes` | `30` | 版本清单与更新说明列表的缓存分钟数 |
| `probeInstallers` | `true` | 是否允许面板探测安装包可用性 |
| `promptContext` | `true` | 是否把当前版本挂进 Agent 运行时上下文 |

## 面板 API

宿主回环路由，只接受本机连接（远程 403）：

```
GET  /dsh-versions/api?op=overview[&force=1]
GET  /dsh-versions/api?op=release&version=0.2.2-rc.3
GET  /dsh-versions/api?op=installer&version=0.2.2-rc.3
GET  /dsh-versions/api?op=progress
GET  /dsh-versions/api?op=downloads
POST /dsh-versions/api   {"op":"download","version":"0.2.2-rc.3"}
POST /dsh-versions/api   {"op":"probe","versions":["0.2.2-rc.3"]}
POST /dsh-versions/api   {"op":"launch","version":"0.2.2-rc.3"}
POST /dsh-versions/api   {"op":"switch","version":"0.2.2-rc.3"}
POST /dsh-versions/api   {"op":"unswitch"}
POST /dsh-versions/api   {"op":"purge","version":"0.2.2-rc.3"}
POST /dsh-versions/api   {"op":"discard","version":"0.2.2-rc.3"}
```

`switch` 要求该版本已经下载过，否则返回「还没下载」；它只启动安装程序并记录意图，
真正的版本变化发生在用户装完并重开 DSH 之后。`downloads` 把已下载清单与切换状态
（`pending` / `applied`）一起返回，面板和 Agent 工具用的是同一份结构。

## 开发

```bash
node test/smoke.mjs    # Host 半边：版本比较、release 解析、缓存、下载/切换、路由、工具
node test/client.mjs   # 客户端：fake React 渲染，检查 slot 注册与面板文案
```

`client.js` 整体包在 IIFE 里：客户端 bundle 会被宿主拼进同一个 `<script>` 批次，
顶层 `const` / `let` 会与其它插件撞名，撞了整条 web boot 都会失败。

## License

MIT

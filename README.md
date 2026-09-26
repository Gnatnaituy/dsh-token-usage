# dsh-token-usage

DeepSeek Harness 的 Token 用量统计插件：在「设置」里新增一个 **Token 用量** 页面，展示

- **总用量**：跨所有模型供应商、所有模型的 token 汇总（今日 / 近 7 日 / 近 30 日 / 全部），
  以及输入、输出、缓存读、缓存写、推理的分项；
- **用量日历**：GitHub 贡献图风格的热力图，每天一格，悬停查看当日 token 明细与请求数；
- **按供应商分组的模型用量**：每个供应商一张表，列出每个模型今日、近 7 日、近 30 日的用量与占比。

数据来自 Harness 自己的会话日志（`assistant/message` 事件的 provider 上报用量），
另外通过 `session/event` 实时记录，无需任何模型调用或第三方计费接口。

## 安装

本机开发安装（软链 + 热挂载，无需重启 DSH Desktop）：

```sh
node tools/install-into-profile.mjs            # 安装
node tools/install-into-profile.mjs --dry-run  # 只看会做什么
node tools/install-into-profile.mjs --uninstall
```

脚本会做三件事（幂等）：

1. 把本仓库软链进 profile 的 `node_modules/dsh-token-usage`；
2. 在 profile 的 `package.json` 里登记 `link:` 依赖；
3. 在 profile 的 `cordis.patch.yml` 里插入一行 Loader 条目
   （`id: token-usage` / `name: dsh-token-usage`），由 DSH 的配置 HMR 热挂载。

装完等一两秒，刷新浏览器页面，打开 **设置 → Token 用量** 即可。

### 通过 bundle 安装（发布/市场场景）

本包自带 `cordis.patch.yml`（`dsh.bundle.patch`）。把包加入 profile 的
`dsh.profile.bundles` 也可以，但**不要同时**既加 bundle 又把行写进 `cordis.patch.yml`：
两处会 insert 同一条目 id，Loader 会报 `duplicate loader entry id`。二选一即可。

## 数据存放

插件只写自己的目录 `<harness home>/dsh-token-usage/`：

| 文件 | 内容 |
|---|---|
| `records.jsonl` | 追加式 JSONL 账本，一行一条用量记录（去重键 `sessionId:seq`） |
| `scan-cache.json` | 每个会话日志的 `{size, mtimeMs}` 快照，增量重扫只读有变化的文件 |

启动时异步扫描一次 `<home>/sessions` 下所有 `*.jsonl.zstd`（多帧 Zstandard 结构扫描，
正在写入的撕裂尾帧也能容错读取），与实时事件流汇入同一账本，天然幂等去重。

## 架构

```
lib/index.js          host 半（Cordis 插件）
  ├─ session/event 监听 → 实时记录 assistant/message 用量
  ├─ UsageStore（lib/store.js）  账本：加载 / 去重 / 追加 / 增量回扫
  ├─ 路由  GET  /dsh-token-usage/summary   汇总快照（JSON）
  │        GET  /dsh-token-usage/status     账本状态
  │        POST /dsh-token-usage/rescan     强制全量重扫
lib/core.js           纯聚合：事件折叠、窗口（今日/7/30/全部）、日历、按供应商分组
lib/session-scan.js   多帧 Zstandard 帧扫描 + 会话日志抽取
lib/client.js         browser 半：设置页 UI（模块加载器 CJS 格式，无构建步骤）
tools/install-into-profile.mjs   安装 / 卸载
test/                 纯逻辑单元测试 + client 冒烟测试（无浏览器、无 harness）
```

页面只读 host 的汇总路由，不自己做任何统计，所以页面与账本永不分叉；
页面上的「重新扫描」按钮对应 `POST /rescan`。

## 开发

```sh
npm test                  # node --test test/（core + session-scan + client 冒烟）
node tools/install-into-profile.mjs --dry-run
```

改 `lib/client.js` 后刷新页面即生效（模块系统按文件 mtime/大小算 revision，重新拉 bundle）。

> client 半要守 React 的 hook 规则：`CalendarCard` 自己用 hook，所以必须写
> `h(CalendarCard, props)` 挂载，不能写成 `CalendarCard(props)`。后者会把它的 hook
> 追加到 `TokenUsageSection` 的 hook 链表上——第一次渲染（loading 占位）看不出来，
> 等 fetch 回来第二次渲染就抛 React error #310，整个设置页内容变空白。
> `test/client-smoke.test.mjs` 里的严格 hook 调度器按 React 的规则比较同一组件前后
> 两次渲染的 hook 数量，会复现这个错误。

改 host 半（`lib/index.js` 等）后需要**重启 DSH Desktop**：模块热重载默认关闭
（`@deepseek-ai/dsh-hmr` 的行是 `root: []`，只监视 profile 配置），本包通过软链挂在
profile 之外，文件事件也不会被监视到。想让 host 半也热重载，可在 profile 补丁里把
`hmr` 行的 `config.root` 指到本仓库路径。

### harness home 的判定

新的 DSH Desktop 把用户数据放在 `~/.dsh`，旧的 Electron 版放在
`~/Library/Application Support/dsh-desktop/harness`。插件按下面的顺序取第一个**存在
`sessions` 目录**的候选作为 harness home，所以同一台机器上装了两套 DSH 也不会读错账本：

1. `ctx.get('dshHomePath')()` —— harness 自己的 home 解析服务（与 harness 完全同源）；
2. `$DSH_HOME`；
3. `~/.dsh`；
4. 旧 Electron 目录（`~/Library/Application Support/dsh-desktop/harness`）。

前三个都不存在 `sessions` 时才退回第 4 个，因此老部署依旧可用；判定结果可在
`GET /dsh-token-usage/status` 的 `ledgerPath` / `sessionsRoot` 里核对。

## 隐私与边界

- 只读 `<home>/sessions` 里的会话日志，只写插件自己的目录；从不删除或改写任何数据。
- 汇总口径与 DSH 持久日志一致：只有 provider 上报了 usage 的 `assistant/message`
  才计为一条；`assistant/attempt`、重试事件不带 usage，不重复计数。
- 没有供应商目录信息时，供应商 id 会做标题化显示；归属不明的记录归到「未标注」。
- 日历配色跟随当前主题（深色/浅色自适应）。
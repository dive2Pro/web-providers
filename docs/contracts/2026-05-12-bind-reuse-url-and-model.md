# Bind Reuse URL And Model Contract

## 目标

调整 helper 的绑定复用流程，让已有的 bind 记录更稳定地复用到原 tab；并把 DeepSeek 的 model 变化纳入绑定判定。

## 交付物

- helper 运行时代码修改
- 相关测试更新或新增
- 本合约文档

## 范围

允许变更：
- `/Users/yc/code/webai-no-fee/src/helper/`
- `/Users/yc/code/webai-no-fee/tests/helper/`
- 必要时补充 README 或 contracts 文档

不允许变更：
- 与本次绑定复用无关的 adapter 行为
- 无关路由和协议语义

## 基线

- 当前 `HelperState` 仍以进程内 `Map<sessionId, Map<provider, BoundSession>>` 维护运行时绑定。
- 当前 `executeProviderChat()` 在内存无绑定时会走 `ensureBound()`，并以 `openNew: true` 触发重新绑定。
- 当前 provider adapter 在传入 `openUrl` 时会优先 `findTabByUrl(openUrl)`，找不到才真正 `open*()`

## 真实链路

`/v1/provider/chat` or `/internal/pi/provider/chat`
-> `HelperRuntime.executeProviderChat()`
-> `ensureBound()`
-> `bindProvider()`
-> provider adapter `bindTab()`
-> bb-browser tab 查找 / 打开

## 验证方式

- helper 单测覆盖“按已记录 URL 复用 tab”的行为
- helper 单测覆盖“DeepSeek model 变化触发不同绑定键/不同复用条件”的行为
- 如涉及持久化，验证服务重启后的首次请求是否按记录复用

## 已确认项

- 用户要求：如果有 bind tab url 的记录，需要复用。
- 用户要求：在 DeepSeek 分支中，切换 model 时也要作为 bind 条件。
- 用户要求：绑定语义从仅 provider 扩展为至少包含 `url`，DeepSeek 还需包含 `model`。
- 用户追加要求：不要求先经过 `/v1/bind` 重新绑定；每一次对话请求都要先自行检查并尝试发现 / 复用现有绑定。
- 用户已确认采用：
  - 本地持久化 binding record，服务重启后从本地记录恢复
  - DeepSeek 按 `sessionId + provider + model` 分开维护绑定

## 已核实项

- 当前 `BoundSession` 只保存 `provider/tabId/tabUrl/...`，不保存请求 model。
- 当前 `HelperRuntime.storeBoundSession()` 的复用判断只看 `tabId` 或 `tabUrl` 是否相同。
- 当前代码库里没有已接入运行时的 session binding store。
- 当前工作区存在未提交的 `.web-providers/session-bindings/helper.json` 本地文件，说明仓库外行为上已经出现过“session binding 持久化”的尝试或产物，但该文件未被当前代码路径读取。

## 推断项

- 无

## 待确认项

- 无

## 当前状态

已完成实现并通过 helper 相关测试。

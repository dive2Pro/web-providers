# Web Provider API Semantics Contract

## 目标

将当前 `web-provider` 的调用语义，从“把网页对话包装成 provider/API”调整为“由 helper 模拟真实 API 调用语义并传递结构化上下文”，使其更适合对接 code agent 类工具。

## 交付物

- 一份已确认的需求合约
- 在本轮确认后，对 `web-provider` 的 contract/runtime 做相应代码改造
- 必要的测试或现有测试更新，用于覆盖新的调用语义

## 范围

允许变更：

- `src/shared/contracts.ts`
- `src/helper/runtime.ts`
- `src/helper/routes/*`
- `src/openai-adapter/*`
- `src/extension/provider-runtime.ts`
- 与上述链路直接相关的测试、文档

暂不默认包含：

- 浏览器自动化底层的大规模重写
- 新 provider 的接入
- 与当前调用链无关的 UI 或 CLI 改造

## 基线

- 当前仓库：`/Users/yc/code/webai-no-fee`
- 当前 helper 已同时暴露：
  - `/v1/provider/chat`
  - `/v1/chat/completions`
  - `/v1/responses`
  - `/internal/pi/provider/chat`
- 当前 `ProviderChatRequest` 结构只有：
  - `provider`
  - `model`
  - `messages`
  - `sessionInit`
  - `temperature`
  - `maxOutputTokens`
  - `abortKey`
- 当前 extension/runtime 和 openai-adapter 都会把上层请求转成 `ProviderChatRequest`

## 真实链路

当前真实执行链路为：

1. 上层入口进入 `src/extension/provider-runtime.ts` 或 `src/openai-adapter/*`
2. 上层被转换成 `ProviderChatRequest`
3. helper 路由进入 `HelperRuntime.executeProviderChat()`
4. `HelperRuntime` 只抽取当前 `messages` 中最后一条 `user` 消息作为真正发给网页的 `prompt`
5. `system/tools/tool_choice/tool results` 并未在 helper 内作为一份真实 API 请求被消费，而主要通过：
   - 首轮 `sessionInit.prompt`
   - 网页已有对话上下文
   - JSON fallback 协议提示词
   来间接生效

## 会话与 Tab 绑定真相

当前代码里，请求是否落到“同一个 tab”，不是由客户端直接传 `tabId` 决定，而是由 helper 运行时中的绑定状态决定。

- 公共 helper 入口 `POST /v1/provider/chat` 从请求头 `x-web-providers-session-id` 读取会话标识；未提供时回退到默认会话 `__default__`
- 内部 `pi` 入口 `POST /internal/pi/provider/chat` 强制要求请求头 `x-pi-session-id`
- `HelperState` 内部实际维护的是 `Map<sessionId, Map<provider, BoundSession>>`
- `BoundSession` 才真正保存 `tabId`、`tabUrl`、`conversationId`、`providerInitFingerprint`、`providerSessionKey`
- 因此“是否复用同一个 tab”的实际判断链路是：`sessionId -> provider -> BoundSession(tabId)`

这意味着：

- 相同 `sessionId` 且相同 `provider` 的重复请求，会优先尝试复用已有 `tabId`
- 不同 `sessionId` 即使请求体完全相同，也会被视为不同会话隔离绑定
- 如果公共请求不传 `x-web-providers-session-id`，它们都会落到默认会话 `__default__`，从而共享默认绑定

## 重复请求与并发语义

当前实现没有真正的幂等去重机制。

- 运行时会先对 `sessionId + provider` 加串行锁；如果同一会话同一 provider 已有请求在执行，会直接返回 `MODEL_BUSY`
- 运行时还会按 `tabId` 检查 `activeRequest`；同一 tab 上已有运行中的请求时，也会返回 `MODEL_BUSY`
- 内部会生成 `requestId` 供 debug 记录使用，但这个 `requestId` 不参与外部重复请求识别，也不会返回上一次结果
- `abortKey` 当前只存在于 contract/debug 记录中，没有形成一套“相同 key 取消旧请求或复用旧结果”的执行语义

因此当前系统对“重复请求”的处理是：

- 如果第一次请求仍在运行，第二次同会话请求通常得到 `409 MODEL_BUSY`
- 如果第一次请求已经结束，第二次重试会再次真正执行一次网页自动化流程
- 代码当前不存在 `requestId`、`Idempotency-Key` 或响应缓存级别的幂等复用

## `conversationId` 的真实含义

当前 `conversationId` 是 helper 本地逻辑 ID，不是远端网页真实会话 ID。

- DeepSeek 当前形如 `conv-${tabId}`
- Qwen 在部分 fresh-session 路径下会生成带时间戳的新值
- 它主要用于本地状态与调试，不代表 helper 能按该 ID 恢复网页历史对话

换句话说，当前连续性主要依赖：

- 当前绑定的 tab 仍然有效
- 网页自身上下文仍然保留
- `sessionInit.fingerprint/sessionKey` 没有触发 fresh session

而不是依赖一个可稳定恢复的远端 `conversationId`。

## 验证方式

完成标准应至少满足：

- helper 接收的核心请求语义能表达 code agent 所需上下文，而不是仅依赖“当前网页会话已记住什么”
- 至少一条真实入口链路在代码上实现统一语义，而不是继续由不同入口各自拼 prompt
- 工具调用信息、tool result、system 约束的传递位置明确
- 相关测试能覆盖新的 contract 或转换逻辑

## 已确认项

- 用户认为当前实现只是把网页端对话“包装”成 API
- 用户希望 `web-provider` 模拟 API 的调用传递信息
- 用户目标是更适合对接其他 code agent 工具

## 已核实项

- `src/helper/runtime.ts` 中 `buildProviderPrompt()` 当前只取 `messages` 里的最后一条 `user` 内容作为实际 prompt
- `src/helper/runtime.ts` 不会在每轮请求中重放完整 `messages`
- `src/extension/provider-runtime.ts` 会把工具协议、system prompt 等信息拼到 `sessionInit.prompt` 和 repair prompt 中
- `src/openai-adapter/helper-client.ts` 也会把 tools/tool_choice 主要转成 prompt 指令，而不是 helper 原生字段
- helper 已经具备 OpenAI 风格公开入口，但底层 contract 仍是 `ProviderChatRequest`
- 公共 helper 会话复用依赖 `x-web-providers-session-id`，而不是请求体里的 `tabId`
- 内部 `pi` 路由通过 `x-pi-session-id` 隔离绑定关系
- 当前没有按重复请求 ID 做幂等去重，只有 `MODEL_BUSY` 级别的串行保护

## 推断项

- 用户所说的“模拟 API 调用传递信息”，大概率不是要求 100% 复刻某家官方 API，而是要求 helper 内部以“结构化 API 请求语义”作为第一公民
- 对 code agent 更关键的问题，不是公开路由名称，而是 helper 是否真正消费完整上下文、工具定义、tool result 和控制参数
- 如果不改变 helper contract，只在上层继续拼 prompt，问题会继续存在

## 待确认项

1. 决策名：改造的权威 contract 放在哪一层
   - 选项 1（推荐）：把 `helper` 的内部/核心 contract 升级成“结构化 agent request”，由 `/v1/provider/chat` 和 `/internal/pi/provider/chat` 共同消费；`/v1/chat/completions`、`/v1/responses` 只做适配层。代价是要改 shared contract、runtime 和上层适配器，但语义最干净。
   - 选项 2：保持 `ProviderChatRequest` 作为核心 contract，只在其上继续追加字段并修补逻辑。代价是改动表面较小，但历史命名和“网页 prompt 包装”语义会继续混在一起。

2. 决策名：本轮要解决到什么深度
   - 选项 1（推荐）：先完成“contract 真实化”，即 helper 原生接收完整结构化上下文，并在 runtime 内统一生成网页侧执行输入；不强求本轮把网页自动化升级为逐条重放历史。代价是仍会保留一部分网页状态依赖，但接口层已经适合 code agent 接入。
   - 选项 2：连同执行语义一起升级，做到 helper 可以根据完整消息历史决定是否重建会话、重放历史、再发送当前轮。代价是范围明显更大，且需要重构浏览器自动化链路。

3. 决策名：对外优先暴露哪条接入链路
   - 选项 1（推荐）：继续保留并强化 `/v1/chat/completions` 与 `/v1/responses`，同时把底层 contract 改正确；`/v1/provider/chat` 作为内部高级调试口保留。代价是需要维护两层接口，但最利于对接现有 code agent 工具。
   - 选项 2：把 `/v1/provider/chat` 直接升级为主要入口，并让其他入口都只是很薄的兼容壳。代价是内部更统一，但外部工具通常还得再做一次适配。

## 当前状态

截至本次核查，关于会话绑定、tab 复用、并发与重复请求处理的代码现实已经明确：

- 会话绑定是 header 驱动的本地运行时映射，不是客户端显式传 `tabId`
- 相同会话会优先复用原 tab，但不提供真正的重复请求幂等
- `conversationId` 只是本地逻辑 ID，不能作为恢复真实网页历史对话的依据

如果后续要把这套 provider 真正做成更接近标准 API 的语义，下一步应优先补的是：

1. 明确的外部幂等键或请求 ID 语义
2. helper 对完整结构化上下文的原生消费能力
3. “fresh session / reuse current tab / replay history” 三者的清晰 contract

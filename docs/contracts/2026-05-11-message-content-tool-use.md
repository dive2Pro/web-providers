# Requirement Contract: message-content-tool-use

## 目标

让当前 provider/runtime 链路能够正确处理直接返回的
`{"type":"message","content":[...]}`
结构，尤其是 `content` 中包含 `tool_use` 块时，不再误判为普通文本或协议错误。

## 交付物

- 一处明确的协议解析/兼容实现
- 覆盖该协议分支的测试
- 对最终上层 agent 事件形态的说明

## 范围

- 允许变更：
  - `src/extension/provider-runtime.ts`
  - 相关测试
- 暂不默认扩散到：
  - helper browser page bridge
  - anthropic/openai adapter 以外的其他协议层
  - 无关日志与文档

## 基线

- 当前 runtime 已支持：
  - 单个 `tool_call`
  - 单个 `tool_calls`
  - 多个并列 `tool_call` 文本块兼容折叠为 `tool_calls`
- 当前 runtime 对 `message` 的解析只接受字符串 `content`

## 真实链路

当前关注的权威链路是：

`provider outputText` -> `src/extension/provider-runtime.ts` 协议解析 -> `ProviderChatResponse` -> pi stream events -> Claude Code / 上层 agent

## 验证方式

- 文本返回 `{"type":"message","content":[{"type":"tool_use",...}]}` 时，行为符合最终确认口径
- 不破坏现有：
  - `tool_call`
  - `tool_calls`
  - 多个并列 `tool_call` 文本块
- 相关测试通过

## 已确认项

- 用户要求考虑 chat 直接返回 `{"type":"message","content":[{"type":"tool_use",...}]}` 这种数据

## 已核实项

- 当前 `ProtocolEnvelope` 中 `message.content` 仅支持字符串
- 当前错误文案仍要求 `{"type":"message","content":"..."}`
- 代码库里已有 Anthropic `tool_use` / `tool_result` 归一化与序列化逻辑，但不在当前 runtime 的 `message.content[]` 解析口径中
- 当前项目存在 `docs/contracts/`，适合存放本合约

## 推断项

- 用户要修的是“runtime 入口对该协议形态的兼容”，不是单纯做日志分析

## 待确认项

1. 决策名：`message.content[]` 中出现 `tool_use` 时，按什么语义处理
   - 选项 1（推荐）：把它视为工具调用协议的另一种写法，直接转成内部 `toolCalls[]`，最终向上层发正式 `toolcall_*` 事件；优点是 Claude Code 能真正执行工具，且与 `tool_call` / `tool_calls` 目标一致。
   - 选项 2：只把它当作一种“消息块”保留，继续作为文本/结构化消息展示，不触发工具执行；优点是更保守，但不能解决“展示了 tool_use 但没调用”的问题。

2. 决策名：`message.content[]` 混合文本块和 `tool_use` 块时怎么处理
   - 选项 1（推荐）：只要存在 `tool_use`，整条消息按工具调用处理，忽略或附带保留非工具文本到 `outputText`；优点是执行语义明确。
   - 选项 2：要求纯 `tool_use` 数组才转工具调用，混合内容仍走 repair/文本；优点是规则更严格，但兼容性更差。

3. 决策名：是否兼容 Anthropic 原生字段名
   - 选项 1（推荐）：兼容 `tool_use` 的 `name` / `id` / `input` 字段，并映射为内部 `name` + `arguments`；优点是正对你给出的样例。
   - 选项 2：只支持现有 `tool_call` / `tool_calls`，不纳入 `message.content[]`；这会直接放弃本次需求。

## 当前状态

待用户确认实现口径，确认后再修改代码。

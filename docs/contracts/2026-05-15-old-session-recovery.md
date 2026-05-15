# 旧 Session 自动恢复需求合约

## 目标

在旧 session 继续对话时，如果原绑定 tab 因页面验证、登录状态失效或页面不可用而无法继续，不再直接失败，而是自动恢复到可继续执行的状态。

## 交付物

- helper/runtime 恢复逻辑代码改动
- 相关适配器或 contract 的必要补充
- 覆盖旧 session 失效后恢复链路的测试
- 本次需求合约文档

## 范围

允许变更：

- `src/helper/runtime.ts`
- `src/helper/browser/*`
- `src/helper/providers/*`
- `src/shared/contracts.ts`
- `src/anthropic-adapter/*`
- `src/openai-adapter/*`
- 与上述链路直接相关的测试

不默认包含：

- 新 provider 接入
- Electron UI 改造
- 与旧 session 恢复无关的日志或协议重构

## 基线

- 当前工作区：`/Users/yc/code/webai-no-fee`
- 当前统一网关同时暴露 helper / OpenAI / Anthropic 兼容入口
- 当前 helper 绑定关系持久化在 `.web-providers/session-bindings/helper.json`
- 当前 helper 请求日志持久化在 `.web-providers/request-logs/*.ndjson`

## 真实链路

当前真实调用链路为：

1. 上层兼容入口把请求标准化为 `NormalizedRequest`
2. helper client 将其转换为 `ProviderChatRequest`
3. `HelperRuntime.executeProviderChat()` 执行绑定、构造 prompt、发送到网页
4. 当前 helper 只取 `messages` 中最后一条 `user` 作为真正发送给网页的 prompt
5. 旧 session 的连续性当前主要依赖“原 tab 里的网页上下文仍然可用”

## 验证方式

- 构造一个已有历史消息的 session
- 让原 tab 进入可恢复错误态后再次请求
- 验证服务能够自动恢复，而不是直接返回 `409/502`
- 验证恢复后当前轮仍能拿到正常响应
- 验证并发保护与正常 fresh session 路径不回归

## 已确认项

- 用户选择“中等修复”方向
- 用户明确希望旧 session 失效时仍能继续原对话
- 用户明确不需要重放标准化消息历史
- 用户明确要求依赖 chat 页面自身已有对话历史，只重发最后一条消息一次

## 已核实项

- Anthropic / OpenAI 入口都会把对话历史标准化后传给 helper
- Anthropic 规范化会把 tool_use / tool_result 压成文本记录，保留在消息历史中
- `HelperRuntime.buildProviderPrompt()` 当前只取最后一条 `user` 消息，而不会重放完整历史
- `conversationId` 当前只是本地逻辑 ID，不是远端网页会话恢复键
- 当前最近一次旧 session 失败链路先出现 `PAGE_UNAVAILABLE`，随后落为 `NOT_BOUND -> 409`
- 当前 DeepSeek 页面出现 `blockingMessage` 时，会被视为页面不可继续聊天

## 推断项

- 用户所说的“中等修复”是在旧 tab 不可用时，自动按原 chat URL 恢复页面，再继续当前轮
- 如果原 chat URL 仍能打开到同一网页会话，那么无需 helper 自己重建历史

## 待确认项

无

## 当前状态

- 已完成旧 session 失败日志、绑定状态和当前执行链路核实
- 已确认恢复方案不做历史重放
- 下一步实现为：旧 tab 失效时，按原 `tabUrl` 重绑，并仅重发当前最后一条消息一次

# Claude Code Integration Contract

## 目标

先让当前仓库具备面向 Claude Code 的接入入口与请求归一化能力，优先解决“Claude Code 能把请求打进来并进入现有 helper 执行链路”，暂不要求本轮完成完整的 Anthropic 风格返回兼容。

## 交付物

- 一份已确认的需求合约
- Claude Code 接入层的最小代码改造
- 必要测试更新，至少覆盖请求入口与归一化链路

## 范围

允许变更：

- `src/shared/contracts.ts`
- `src/openai-adapter/*` 或新增相邻 adapter 模块
- `src/helper/routes/*`
- `src/helper/runtime.ts`
- 与上述链路直接相关的测试与文档

暂不默认包含：

- 浏览器自动化底层重写
- Anthropic 完整响应序列化
- 完整 streaming 兼容
- 工具结果多轮闭环完全对齐 Claude Code

## 基线

- 当前仓库：`/Users/yc/code/webai-no-fee`
- 仓库已存在 helper 服务和 OpenAI 兼容 adapter
- 当前 helper 核心 contract 仍偏向 prompt 包装，而非原生结构化 agent request
- 当前工作区存在未提交改动，涉及 helper、openai-adapter 和测试文件

## 真实链路

本轮拟改造的真实链路是：

1. Claude Code 通过自定义 base URL 调用本地 gateway
2. gateway 接收 Anthropic Messages 风格请求
3. gateway 将请求归一化为仓库内部 contract
4. helper 执行既有 provider/browser 自动化链路

本轮不要求：

- 最终返回 100% 满足 Claude Code 的全部响应语义
- 完整复刻 Anthropic 官方所有边缘字段

## 验证方式

完成标准至少包括：

- 存在 Claude Code 可调用的入口路径
- 入口能够接受 Anthropic Messages 风格请求体并完成基础校验/归一化
- 请求能进入现有 helper 执行客户端调用链
- 有测试覆盖入口和归一化逻辑

## 已确认项

- 用户要“先改对接，后续的返回不着急”
- 本轮重点是接入，不是完整返回兼容
- 用户确认采用独立 `anthropic-adapter` 模块与 `/v1/messages` 路由

## 已核实项

- 当前仓库已有 OpenAI 风格入口：`/v1/chat/completions`、`/v1/responses`
- 当前 `ProviderChatRequest` 只支持简单的 `role + content` 文本消息
- 当前 helper 在 `buildProviderPrompt()` 中只实际取最后一条 `user` 消息作为 prompt
- 当前 openai-adapter 通过 `sessionInit.prompt` 拼接 system/tools 约束，而不是 helper 原生消费结构化工具语义
- 当前工作区为脏状态，已有未提交改动，不应回退

## 推断项

- 用户当前更在意 Claude Code 能打通入口，而不是一次性完成全部 Anthropic 兼容
- 本轮可以接受“请求语义先对齐，响应先最小可用或占位”

## 待确认项

无

## 当前状态

已完成独立 `anthropic-adapter` 的最小接入实现，包括：

- `/v1/messages`
- `/v1/messages/count_tokens`
- `/v1/models`
- Claude Code 会话头映射
- Claude Code 友好的 `anthropic-*` 模型别名

已通过定向测试与 TypeScript 编译。

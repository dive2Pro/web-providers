# Parallel Tool Calls Contract

## 目标

评估并规划当前 `web-provider` 改造为支持并行工具调用的最小可行路径，明确本轮要改到的 contract、执行语义和验证范围。

## 交付物

- 一份已确认的需求合约
- 一份基于当前代码事实的改造方案
- 用户确认后，再进入代码实现与测试

## 范围

允许变更：

- `src/shared/contracts.ts`
- `src/helper/runtime.ts`
- `src/helper/browser/*`
- `src/openai-adapter/*`
- `src/anthropic-adapter/*`
- `src/extension/provider-runtime.ts`
- 与上述链路直接相关的测试

暂不默认包含：

- 浏览器自动化大规模重写
- 新 provider 接入
- 与工具调用并行无关的日志、网关、UI 变更

## 基线

- 当前仓库：`/Users/yc/code/webai-no-fee`
- 当前工作区存在未提交改动和未跟踪文件
- helper 当前支持 `deepseek-web` 与 `qwen-web`
- helper 对同一 `sessionId + provider` 做串行保护
- 适配层同时暴露 OpenAI 与 Anthropic 风格入口

## 真实链路

1. OpenAI/Anthropic/extension 入口先把上层请求归一化
2. 归一化结果进入 helper `executeProviderChat()`
3. helper 绑定或复用对应 tab
4. helper 发送一次网页 prompt，等待一轮结果
5. helper 把结果翻译回 text 或单个 tool call
6. 上层把该结果再序列化成 OpenAI/Anthropic 兼容响应

## 验证方式

完成标准至少包括：

- 同一轮响应可以表达多个 tool call，而不是只有一个
- OpenAI 响应层能正确输出多个 `tool_calls`，并在需要时声明 `parallel_tool_calls`
- Anthropic 响应层能正确输出多个 `tool_use`
- extension/runtime 能逐个消费该轮返回的多个工具调用
- 保留现有“同一 session/provider 不并发跑两次网页请求”的保护，除非本轮明确决定放开
- 相关测试覆盖单工具、多工具、无工具三类结果

## 已确认项

- 用户当前要的是“并行调用工具”的改造方案，不是立即开始实现

## 已核实项

- 当前 README 明确写明：同一 `sessionId + provider` 只允许一个进行中的请求，并发请求返回 `MODEL_BUSY`
- `src/helper/runtime.ts` 会先按 `sessionId + provider` 加锁，再按 `tabId` 检查运行中请求
- `ProviderChatResponse` 当前只有单个 `toolCall` 字段，没有 `toolCalls[]`
- OpenAI `responses` 序列化层当前固定返回 `parallel_tool_calls: false`
- Anthropic `messages` 序列化层当前一次只输出一个 `tool_use`
- extension runtime 当前按单个 `response.toolCall` 发出 toolcall 事件
- 不同 `sessionId` 绑定不同 tab 时，当前测试已证明请求级并行是允许的

## 推断项

- 用户说的“并行调用工具”更可能指“一轮模型输出里包含多个工具调用，并允许上游并行执行”，而不是“同一个网页会话里并行发多个 provider turn”
- 当前系统的主要瓶颈不在 HTTP 层，而在 shared contract、helper 输出形态和上层消费逻辑都被单个 `toolCall` 写死

## 待确认项

1. 决策名：你要的“并行”是哪一层
   - 选项 1（推荐）：支持“单轮返回多个 tool calls”，但仍保持同一 `sessionId + provider` 的 provider turn 串行。这是最小且正确的改造路径。
   - 选项 2：允许同一 `sessionId + provider` 并发跑多个 provider turn。代价很高，会直接冲击 tab 状态、网页上下文一致性和错误恢复。

2. 决策名：本轮 contract 是否升级为多工具一等公民
   - 选项 1（推荐）：把 `toolCall` 升级为 `toolCalls[]`，并让所有适配层都按数组处理；单工具只是一种长度为 1 的特例。
   - 选项 2：保留现有 `toolCall`，只在 OpenAI/Anthropic 序列化层做表面兼容。代价是 helper 与 extension 语义继续失真，不建议。

3. 决策名：网页侧能力的目标语义
   - 选项 1（推荐）：只支持“模型在一轮最终结果里返回多个工具调用”，由上游决定是否并行执行这些工具。
   - 选项 2：继续追求“网页流式增量地产生多个工具调用并交错输出”。代价较高，且当前 bridge 和运行时都不是按这个模型设计的。

## 当前状态

- 当前代码不支持“单轮多个工具调用”
- 当前代码支持“不同 session 绑定不同 tab 时的请求级并行”
- 当前代码不适合作为“同会话多 turn 并发执行”的基础
- 如按推荐方案推进，第一步应先改 shared contract 和 helper 出参，再改 OpenAI/Anthropic/extension 消费层

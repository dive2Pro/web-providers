# OpenAI 伪流式设计

## 摘要

扩展 `openai-adapter`，让 `stream: true` 不再直接失败，而是返回一种 buffered pseudo-stream。对调用方来说，它看起来像 OpenAI 的流式接口；对内部实现来说，仍然基于 helper 当前的非流式执行模型。

adapter 需要做到：

- `/v1/chat/completions` 和 `/v1/responses` 都接受 `stream: true`
- 先等待 helper 完整执行结束
- 再把最终结果按 OpenAI 风格 SSE 事件回放给客户端
- 同时支持文本输出和 tool call 输出

adapter 不应声称这是真正的 token 级流式输出。

## 目标

- 避免 OpenAI 风格 SDK 或客户端在请求流式时直接失败
- 兼容期望 `text/event-stream` 的调用方
- 让文本回复和 tool call 都能走流式接口表面
- 保持 helper 继续作为非流式执行层，不改内部执行模型

## 非目标

- 真正的逐 token 流式输出
- 更早的首 token 延迟
- 浏览器模型实时增量吐出 tool arguments
- 生成过程中的真实上游取消
- 把 helper 重构成流式传输架构

## 当前上下文

helper 现在会先完整执行浏览器驱动请求，再返回结果。adapter 再把这个完整结果序列化成 OpenAI 风格的非流式 JSON。

最近的真实 E2E 验证已经确认：

- 非流式 JSON 响应可以正常工作
- 在补上 session 初始化提示后，tool calling 已经可以工作
- `stream: true` 目前会返回稳定的 `400 unsupported_feature`

这说明下一步不该是“真流式”，而应该是一个流式外观层：对调用方保持协议兼容，对 helper 继续保持当前契约。

## 设计行为

当请求里带 `stream: true` 时，adapter 应该：

1. 接受请求
2. 按现在的方式调用 helper
3. 等待 helper 返回完整结果
4. 使用 OpenAI 风格 SSE 事件把这个最终结果回放给客户端
5. 在适用时用 `data: [DONE]` 收尾

这是一种 buffered pseudo-stream：

- 协议表面是流
- 上游执行仍是非流式
- 首字节要等 helper 完整执行后才会开始返回

## 架构

adapter 应增加两类独立的流式序列化器：

- `serializeChatCompletionsStream`
- `serializeResponsesStream`

请求处理链路保持不变：

1. route 解析请求
2. 解析模型
3. 归一化请求
4. helper client 执行请求
5. adapter 根据 `stream` 选择：
   - `stream !== true` 时走普通 JSON serializer
   - `stream === true` 时走 SSE serializer

这样流式行为就完全封装在 adapter 层，不会污染 helper。

## Chat Completions 伪流式

### 文本输出

文本输出时，adapter 应按以下顺序发 SSE chunk：

1. assistant role chunk
2. 一个或多个 content delta chunk
3. 带 `finish_reason: "stop"` 的结束 chunk
4. `data: [DONE]`

事件载荷应使用 `object: "chat.completion.chunk"`。

V1 可以只把最终文本作为一个完整 content delta 发出，不需要伪装成逐 token 增量。

### Tool Call 输出

tool call 输出时，adapter 应按以下顺序发 SSE chunk：

1. assistant role chunk
2. 一个或多个 tool call delta chunk
3. 带 `finish_reason: "tool_calls"` 的结束 chunk
4. `data: [DONE]`

每个 tool call delta 应带 OpenAI 风格的 `tool_calls` 条目，至少包括：

- `index`
- `id`
- `type: "function"`
- `function.name`
- `function.arguments`

V1 允许把 arguments 一次性完整发出，而不是拆成更细的增量。

## Responses 伪流式

Responses API 的事件分类比 Chat Completions 更散。V1 不需要把整套 taxonomy 做满，只需要做一组“足够兼容”的子集。

### 文本输出

adapter 应发出：

1. response created 或 start 事件
2. output text delta 事件
3. output text done 或 response completed 事件

### Tool Call 输出

adapter 应发出：

1. response created 或 start 事件
2. function call delta 或完整 function call 事件
3. response completed 事件

目标不是完全复刻 OpenAI 所有细节，而是让 OpenAI 风格客户端不至于因为事件形状不对而中断。

## 事件序列化策略

adapter 不应试图用一个泛化的流式事件抽象同时覆盖两套协议。

建议拆成两套独立实现：

- Chat Completions 流式是 `choices[0].delta` 语义
- Responses 流式是 response-event 语义

共享抽象应止步于“完整执行结果对象”；真正的流式事件构造应保持 route 级别分离。

## 错误处理

因为这是 buffered pseudo-stream，大多数失败都会发生在 adapter 真正开始写 SSE 之前。

V1 规则：

- 如果 helper 在开始回放前失败，直接返回普通 JSON 错误响应
- 不要先开始写 SSE，再在中途切换回 JSON 错误

这样传输行为最稳定。

adapter 还应继续保持当前错误翻译语义：

- `MODEL_BUSY` -> `429`
- `NOT_BOUND` -> `409`
- `TIMEOUT` -> 对应超时错误
- 自动化失败 -> 对应上游失败错误

## 客户端断开

客户端断开连接时，最多只能停止 adapter 自己的 SSE 回放，不应把它描述成真正的上游取消。

helper 当前执行链路并不具备流式语义下的真实可取消能力，所以大多数情况下仍会继续跑到结束。

这点需要明确写在文档里：

- 客户端取消只会停止下游回放
- 不保证 helper 侧同步取消

## 并发

伪流式不会改变 helper 当前的并发能力。

现有约束仍然成立：

- helper 同时只允许一个活跃请求
- 并发请求仍可能收到 `429 model_busy`

adapter 不应让调用方误以为“支持 stream 以后就支持更高并发”。

## 超时

超时仍由 helper 主导。

如果 helper 在 adapter 开始写 SSE 之前就超时了：

- 直接返回翻译后的 JSON 超时错误

adapter 不应在拿到完整 helper 结果前就提前开启 SSE 响应。

## 响应头与内容类型

当 `stream: true` 时，adapter 应设置 SSE 相关响应头，包括：

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`

响应体使用 `data: <json>\n\n` 的 SSE framing。对于 Chat Completions，还应使用 `data: [DONE]\n\n` 收尾，以兼容常见 OpenAI 客户端。

## 测试策略

需要增加以下测试：

- chat completions 文本 pseudo-stream
- chat completions tool call pseudo-stream
- responses 文本 pseudo-stream
- responses tool call pseudo-stream
- helper 在回放前失败时的 streaming 请求
- `MODEL_BUSY` 下的 streaming 请求
- 非流式请求行为保持不变

测试至少要验证：

- HTTP 状态码
- SSE content type
- 事件顺序
- 事件 payload 形状
- `[DONE]` 的结尾行为

## 风险

- 某些客户端虽然能接受这种伪流式，但由于首字节要等完整结果，体验上仍会感觉“卡住”
- 某些客户端可能依赖更细的 OpenAI 事件分类，V1 未必完全满足
- tool call 流式兼容性会受客户端预期影响，有些客户端可能更偏好细粒度 arguments delta，而不是一次性完整 arguments

## 验收标准

满足以下条件时，可以认为设计成功：

- 客户端可以对 `/v1/chat/completions` 发送 `stream: true`，并消费 SSE，而不是收到错误
- 客户端可以对 `/v1/chat/completions` 发送 `stream: true` + tool calling，并收到 tool call SSE chunk
- 客户端可以对 `/v1/responses` 发送 `stream: true`，并收到可消费的 SSE 响应
- helper 内部执行仍保持非流式，不需要重构
- 文档明确说明这是一种 buffered pseudo-stream，而不是真正的 token 级流式

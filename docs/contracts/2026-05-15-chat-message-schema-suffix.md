# 合约：chat 消息尾部追加结构声明

## 目标

在发送给 chat provider 的消息中，按约定在消息末尾追加一段“返回数据结构声明”，使模型输出遵循指定结构。

## 交付物

- 明确结构声明追加在哪一层链路
- 按确认方案实现消息尾部追加
- 覆盖对应回归测试

## 范围

- 允许修改：
  - `src/helper/runtime.ts`
  - `src/shared/code-agent-prompt.ts`
  - 相关测试
- 暂不改：
  - provider 页面自动化
  - helper 路由协议字段
  - OpenAI / Anthropic adapter 的外部入参设计

## 基线

- 当前 helper 侧通过 `buildProviderPrompt(...)` 组装真正发到网页 chat 输入框的 prompt
- 当前 helper 只消费本轮最后一条 `user` 消息作为真正发送内容
- 当前不存在“每次真正发送到 chat 的用户 prompt 尾部统一追加结构声明”的逻辑

## 真实链路

OpenAI / Anthropic / extension
-> helper `/v1/provider/chat` or `/internal/pi/provider/chat`
-> `src/helper/runtime.ts`
-> `buildProviderPrompt(...)`
-> browser `sendChatPrompt(...)`
-> web provider

## 验证方式

- 真正发到网页的 prompt 会在末尾追加目标声明
- session init 仍只负责首轮初始化，不替代每轮追加
- 现有 repair / retry 回退测试继续通过

## 已确认项

- 用户希望“在每次发送给 chat 消息时，都在最后拼接一段要求返回的数据结构声明”
- 追加范围：只针对 `user` 消息语义生效
- 追加位置：追加到目标消息末尾

## 已核实项

- 真正发送到网页 chat 的入口在 `src/helper/runtime.ts`，不是 extension 的消息压平层
- helper 内已经存在“结构不合法则 repair / retry”的拦截链路
- 现有 repair 口径已经定义了统一 JSON envelope 要求与示例
- 仓库当前存在未提交改动，但与本需求的目标文件尚未直接冲突

## 推断项

- 无

## 待确认项

- 无

## 当前状态

- 已完成：将结构声明追加到 helper 实际发送 prompt 的用户消息末尾
- 已完成：结构声明复用现有 retry / repair 口径，避免多套协议文本漂移
- 已完成：补齐 helper 侧回归测试

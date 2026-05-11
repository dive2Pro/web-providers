# SessionInit Binding Contract

## 目标

调整 `sessionInit` 语义，避免同一个 Claude Code session 在已绑定 tab 的前提下，因为 `fingerprint/sessionKey` 变化而触发新的 DeepSeek/Qwen chat。

## 交付物

- helper / adapter 代码修改
- 对应测试更新
- 复现链路验证结果

## 范围

- 允许变更：
  - `src/helper/runtime.ts`
  - `src/helper/types.ts`
  - `src/shared/contracts.ts`
  - `src/anthropic-adapter/helper-client.ts`
  - `src/openai-adapter/helper-client.ts`
  - 相关测试
- 暂不变更：
  - browser automation 具体 DOM 逻辑
  - gateway 路由语义

## 基线

- 当前 helper 使用 `sessionInit.prompt` 作为首次 prompt 前缀
- 当前 helper 使用 `sessionInit.fingerprint/sessionKey` 判断 `shouldStartFresh`
- 当前绑定维度已经支持 `sessionId -> provider -> tab`

## 真实链路

`Claude Code -> gateway -> adapter helper-client -> helper /v1/provider/chat -> bound browser tab -> provider page`

## 验证方式

- 同一 `x-claude-code-session-id` 下，先发“会话标题生成”再发“正式对话”
- 不应因 `sessionInit.fingerprint/sessionKey` 差异而新建 chat
- 首轮 system/tool prompt 仍应能正确注入
- 既有工具调用与普通文本测试应保持通过

## 已确认项

- 用户认为当前 `sessionInit` 有问题
- 用户希望复用主要依赖已有 `bind tab`
- 用户已确认采用选项 1：保留 `sessionInit.prompt`，移除 `fingerprint/sessionKey` 的 freshness 作用

## 已核实项

- `sessionInit` 目前同时承担两件事：
  - 首轮 prompt 初始化
  - 会话 freshness 判定
- live 复现里，“标题生成请求”和“正式对话请求”使用了不同的 `sessionInit.fingerprint/sessionKey`
- helper 因此触发了 `startNewChat()`

## 推断项

- 用户更想去掉 `fingerprint/sessionKey` 对“是否新开 chat”的控制，而不是去掉 `sessionInit.prompt` 本身

## 待确认项

无

## 当前状态

- 已完成 live 根因定位
- 已按确认方案完成实现：
  - `sessionInit` 协议仅保留 `prompt`
  - helper 仅在绑定 tab 尚未初始化时注入一次 prompt
  - 后续同 tab 请求不再因 `sessionInit` 变化触发新 chat
- 已完成测试：
  - `tests/helper/provider-chat.test.ts`
  - `tests/anthropic-adapter/app.test.ts`
  - `tests/openai-adapter/app.test.ts`
  - `tests/extension/index.test.ts -t "injects fallback instructions and emits pi tool-call events for structured tool turns"`
  - `pnpm build`
- 已完成 live 验证：
  - 标题生成请求不再进入 helper provider chat
  - 正式请求中的 `sessionInit` 仅包含 `prompt`

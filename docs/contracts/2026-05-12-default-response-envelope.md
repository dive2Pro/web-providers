# 合约：默认开启返回格式约束

## 目标

把 provider 返回格式约束从“仅 tools 场景启用”改为“默认启用”，让纯聊天请求也默认要求返回单个 JSON envelope，并在不符合时进入 helper repair。

## 交付物

- OpenAI / Anthropic helper client 默认注入统一的 JSON envelope 指令
- helper 对纯文本裸回复也执行返回格式修复
- 覆盖无 tools 场景的回归测试

## 范围

- 允许修改：
  - `src/openai-adapter/*`
  - `src/anthropic-adapter/*`
  - `src/helper/*`
  - 相关测试
- 不改：
  - provider 页面自动化本身
  - 外部 API 的请求字段设计

## 基线

- 当前 API 侧 helper client 仅在 `tools.length > 0` 时注入 JSON envelope 指令
- 当前 helper 仅把“看起来像协议但格式不对”的返回视为需要 repair，普通裸文本会直接放行
- extension 侧 provider runtime 已默认注入 envelope 指令，API 侧行为与其不一致

## 真实链路

`/v1/messages` or `/v1/chat/completions` or `/v1/responses`
-> adapter normalize
-> adapter helper client `buildSessionInit(...)`
-> helper `/v1/provider/chat`
-> `HelperRuntime.executeProviderChat(...)`
-> `getProviderResponseRepairDecision(...)`

## 验证方式

- 无 tools 请求也会向 helper 下发 `sessionInit`
- 无 tools 请求的 `sessionInit` 包含 JSON envelope 指令和“不要调用工具”的约束
- provider 首次返回裸文本时，helper 会发起 repair，而不是直接返回给上游

## 已确认项

- 用户要求“默认都开启”

## 已核实项

- `src/openai-adapter/helper-client.ts` 与 `src/anthropic-adapter/helper-client.ts` 当前都只在 `hasTooling` 时注入 envelope 指令
- `src/helper/provider-response.ts` 当前只对 protocol-like 但不合法的返回触发 repair
- `src/extension/provider-runtime.ts` 已默认注入 envelope 指令

## 推断项

- 无

## 待确认项

- 无

## 当前状态

- 已完成：API 侧 helper client 现已默认注入 JSON envelope 指令，helper 对裸文本默认执行 repair，并补充了无 tools 与纯文本修复回归测试

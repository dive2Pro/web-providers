## 目标

修复合并版 helper app 中 Anthropic `POST /v1/messages` 路由把可预期 helper 异常错误地返回为 `500` 并触发上游 retry 的问题，同时把 `bb-browser` 从“要求全局安装”改为项目内依赖。

## 交付物

- 合并版 helper app 的错误映射修复
- `bb-browser` 项目内依赖与本地二进制解析
- 针对上述行为的测试
- README 中的依赖说明同步

## 范围

- 允许修改运行时错误映射、`bb-browser` 调用方式、依赖清单、测试和相关说明
- 不处理与本任务无关的现有脏工作区改动

## 基线

- 仓库已有 `src/helper/browser/bb-browser-client.ts`，当前直接调用全局命令 `bb-browser`
- 仓库已有合并版 helper app，并在 `src/helper/app.ts` 中挂载 `/v1/messages`
- 当前工作区存在未提交修改：`README.md`、`package.json`、`src/extension/provider-runtime.ts`、`src/helper/app.ts`、`src/shared/request-logging.ts`、`tests/helper/merged-openai.test.ts`、`.web-providers/request-logs/helper.ndjson`

## 真实链路

`/v1/messages` -> `src/anthropic-adapter/routes/messages.ts` -> 合并版 helper app 中的 execution client -> `HelperRuntime.executeProviderChat(...)`

`bb-browser` 调用链路：
`src/helper/browser/bb-browser-client.ts` -> 子进程调用 `bb-browser`

## 验证方式

- 目标测试覆盖 `/v1/messages` 在 helper 抛出已知错误时不再返回泛化 `500`
- 目标测试覆盖 `bb-browser` 本地命令解析
- 代码检视确认 README 不再要求全局安装 `bb-browser`

## 已确认项

- 用户要求检查 log 并修复“对话中出现 retry”
- 用户要求把 `bb-browser` 改为项目内依赖

## 已核实项

- `.web-providers/request-logs/helper.ndjson` 中存在 `2026-05-12T01:42:05Z` 到 `2026-05-12T01:42:13Z` 的连续 `POST /v1/messages?beta=true` `500` 记录，单次耗时 `1-2ms`
- 当前 `src/helper/browser/bb-browser-client.ts` 多处硬编码 `execFile(..., "bb-browser", ...)`
- `package.json` 当前未声明 `bb-browser` 依赖
- npm registry 上存在 `bb-browser@0.11.6`，并暴露 `bb-browser` bin
- 当前机器全局 `bb-browser` 版本为 `0.10.1`，项目内安装版本为 `0.11.6`
- 通过 `curl /v1/debug/provider-last?provider=deepseek-web` 核实失败请求的 provider prompt 长度约 `100110`
- 用 `execFile(process.execPath, ["node_modules/bb-browser/dist/cli.js", "eval", script, "--json"])` 复现到：`document.title` 可用，但带换行的 bridge 脚本会被 `bb-browser@0.11.6` 误判为“缺少 script 参数”

## 推断项

- 上游出现 retry 的直接触发因素是合并版 `/v1/messages` 返回瞬时 `500`，而非 provider 实际长时间超时
- “项目内依赖”按当前项目结构应实现为 `package.json` 依赖并在运行时优先解析本地安装的 `bb-browser`

## 待确认项

无

## 当前状态

进行中：已完成本地依赖解析与 Anthropic 错误映射，正在修复 `bb-browser@0.11.6` 对多行 `eval` 脚本的兼容性问题并补回归验证。

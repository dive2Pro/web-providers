# 路由请求日志需求合约

## 目标

为项目中的 HTTP 路由请求增加可分析的访问日志，便于后续排查调用链和统计路由使用情况，并按用户新增要求记录请求 body 和 header，同时将日志保留到本地并提供 API 访问。

## 交付物

- 路由请求日志相关代码改动
- 本地日志保留能力
- 日志查询 API
- session 绑定调试 API
- 对应测试更新或新增
- 本合约文档

## 范围

- 允许变更 `src/helper/`、`src/openai-adapter/`、`src/anthropic-adapter/`、`src/gateway/` 下与应用入口或公共日志能力相关的代码
- 允许变更对应测试
- 不改动业务协议和返回结构，除非为日志埋点所必需

## 基线

- 当前仓库存在四个 Fastify 应用入口：
  - `src/helper/app.ts`
  - `src/openai-adapter/app.ts`
  - `src/anthropic-adapter/app.ts`
  - `src/gateway/app.ts`
- 当前项目未见统一 HTTP 访问日志实现
- 当前工作区存在用户未提交改动，需避免覆盖无关修改

## 真实链路

- HTTP 请求先进入各自 `build*App()` 创建的 Fastify 实例
- 各应用当前已使用 `onRequest` 处理鉴权，适合作为补充日志 hook 的落点之一

## 验证方式

- 单元测试验证日志 hook 在请求进入后会产生预期日志
- 现有相关测试继续通过

## 已确认项

- 用户需求：为路由请求添加 log，用于分析
- 用户新增需求：日志需要记录 body 和 header
- 用户确认：日志覆盖范围选择“4 个入口都加统一日志”
- 用户确认：header 记录策略选择“记录原始完整 header”
- 用户确认：body 记录策略选择“记录原始完整 body”
- 用户确认：本地保留方式选择“写本地 NDJSON 文件”
- 用户确认：API 暴露范围选择“每个 app 各自提供 `/v1/debug/request-logs`”
- 基于用户授权的代理决策：在 helper 新增受保护的 session 绑定调试 API，暴露 `sessionId -> provider -> tabId` 摘要映射

## 已核实项

- 项目根目录已有 `docs/contracts/`，适合作为合约留档位置
- `package.json` 中测试命令为 `vitest run`
- 代码检索未发现现成的统一 logger 或路由访问日志封装

## 推断项

- 用户希望日志能覆盖排查请求内容，而不仅是路由级元信息
- 直接记录原始 `authorization`、`x-api-key` 等 header，以及完整请求体，存在敏感信息泄露风险
- 默认本地目录采用仓库下 `.web-providers/request-logs/`
- 查询 API 默认返回最近日志，按最新优先排序
- session 绑定调试 API 默认应要求鉴权，因为返回内容包含 `sessionId` 与 `tabId`

## 待确认项

无

## 当前状态

- 已完成项目入口、现有日志能力、工作区状态核实
- 已按用户确认方案完成统一日志 hook 的第一步接线
- 已完成本地 NDJSON 存储与按 app 暴露的日志查询 API
- 正在补充 helper 的 session 绑定调试 API

# Gateway Merge Contract

## 目标

将当前独立的 `openai-adapter` 与 `anthropic-adapter` 启动服务合并为一个可同时承载两套协议入口的 `gateway` 进程，同时保持 OpenAI 与 Anthropic 的请求归一化、序列化与流式协议逻辑继续独立。

## 交付物

- 一份已确认的需求合约
- 新的 merged gateway 进程入口与配置
- 相关测试，覆盖至少一条 OpenAI 路由与一条 Anthropic 路由在同一进程内工作

## 范围

允许变更：

- `src/openai-adapter/*`
- `src/anthropic-adapter/*`
- 新增 `src/gateway/*`
- `package.json`
- `tests/*`
- `docs/contracts/*`

暂不默认包含：

- 删除现有单独 adapter 入口
- 改写 helper/browser 自动化逻辑
- 统一 OpenAI 与 Anthropic 的内部 normalize/serialize 实现

## 基线

- 当前仓库已有独立的 `openai-adapter` 与 `anthropic-adapter`
- 两者都已通过本地 helper client 调用 `helper /v1/provider/chat`
- `GET /v1/models` 在两套协议中存在路径冲突，但响应体形状不同

## 真实链路

本轮真实链路为：

1. 单个 `gateway` 进程启动
2. 进程内部创建共享 helper client
3. 同时挂载：
   - OpenAI 风格路由
   - Anthropic 风格路由
4. `GET /v1/models` 由 merged gateway 统一返回兼容超集
5. `GET /v1/models/:modelId` 继续为 Anthropic 模型详情服务

## 验证方式

完成标准至少包括：

- 存在新的 merged gateway 启动脚本
- 同一进程同时支持 OpenAI 与 Anthropic 路由
- `GET /v1/models` 不因路径冲突而崩溃
- 相关测试与 TypeScript 编译通过

## 已确认项

- 用户确认可以合并启动服务
- 采用“合并启动层，不合并协议实现层”的方案

## 已核实项

- `src/openai-adapter/app.ts` 与 `src/anthropic-adapter/app.ts` 都是 Fastify app + helper client + route registration
- 两套协议唯一显著直接冲突的公开路径是 `GET /v1/models`
- OpenAI 与 Anthropic 的消息/流式语义仍有明显差异，不适合在本轮揉成一个协议实现

## 推断项

- merged gateway 最适合继续保留单独 adapter 入口作为兼容层，而不是立即删除

## 待确认项

无

## 当前状态

已完成边界确认，开始实现 merged gateway。

# Web Providers

**Web Providers** 是一个基于 Fastify 的轻量级后端服务，旨在将网页版 AI 模型（如 DeepSeek、Qwen 等）桥接为标准 API 接口。它通过维护本地 `sessionId -> provider -> browser tab` 的绑定关系，并转译页面状态与回复结果，让开发者能以 API 形式调用网页版 AI 的能力。

## ⚙️ 环境准备

在项目根目录安装依赖后再启动服务：

```bash
npm install
```

`bb-browser` 已作为项目依赖声明，无需再单独全局安装。

## 🚀 使用方式

安装完成后，在项目根目录下启动服务：

```bash
npm run dev
```

默认会启动统一网关服务，监听以下端口（可通过环境变量配置）：
- **网关主服务**：整合了 helper、OpenAI 兼容和 Anthropic 兼容路由
- **请求日志**：自动记录到 `.web-providers/request-logs/` 目录

提供以下路由组：
- Helper 原生路由：`/v1/health`、`/v1/chat`、`/v1/provider/chat`、`/v1/bind`、`/v1/reset`
- OpenAI 兼容路由：`/v1/models`、`/v1/chat/completions`、`/v1/responses`
- Anthropic 兼容路由：`/v1/messages`、`/v1/messages/count_tokens`

## ✨ 特性

- 🚀 **多提供商支持**: 目前已支持 `deepseek-web` 和 `qwen-web`，架构易于扩展。
- 🔌 **统一网关**: 单进程同时提供 Helper、OpenAI 和 Anthropic 兼容 API，减少部署复杂度。
- 🛠️ **多工具调用**: 支持在一次请求中并行调用多个工具（multi-tool use），适配 Claude、GPT 等模型的原生工具调用格式。
- 🔒 **会话绑定**: 通过本地会话头把请求绑定到已发现的浏览器 tab，而不是让客户端直接传 `tabId`。
- 🚦 **请求串行化**: 同一 `sessionId + provider` 在同一时间只允许一个进行中的请求，并发请求会返回 `MODEL_BUSY`。
- 🚪 **请求门控**: 自动记录每个请求的输入输出和耗时，支持按会话维度追踪和调试（日志存储于 `.web-providers/request-logs/`）。
- 🛡️ **类型安全**: 全面使用 TypeScript 和 TypeBox 进行数据校验。
- 📊 **监控与健康检查**: 内置 `/v1/health` 端点，实时监测服务与浏览器连接状态。

## 📖 API 概览

| 方法 | 路径 | 描述 |
|------|------|------|
| `POST` | `/v1/bind` | 绑定并初始化 AI 提供商页面会话 |
| `POST` | `/v1/chat` | 发送聊天请求（简单文本） |
| `POST` | `/v1/provider/chat` | 高级提供商聊天接口（支持工具调用、多工具并行） |
| `POST` | `/v1/reset` | 重置指定提供商状态 |
| `GET`  | `/v1/health` | 检查服务及浏览器连接健康状态 |
| `POST` | `/v1/messages` | Anthropic Messages API 兼容端点 |
| `POST` | `/v1/messages/count_tokens` | Anthropic token 计数端点 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions 兼容端点 |
| `POST` | `/v1/responses` | OpenAI Responses API 兼容端点 |

## 🧩 高级功能

### 多工具并行调用
`POST /v1/provider/chat` 支持在请求中携带 `tools` 数组，并且允许模型在一次响应中返回多个 `tool_calls`。网关会自动将网页版模型的单次工具调用结果聚合为多工具格式，兼容 Claude/GPT 风格的工具调用协议。

### 请求门控与日志
所有通过网关的请求（包括 helper、OpenAI、Anthropic 路由）都会自动记录以下信息：
- 请求时间、方法、路径、来源 IP
- 请求体摘要（可选记录完整 body）
- 响应状态码、耗时
- 会话标识（如果请求带有 `x-web-providers-session-id`）

日志文件按日轮转，存储于 `.web-providers/request-logs/gateway.ndjson` 和 `helper.ndjson`，便于调试和审计。

## Session 语义

- 公共 helper 入口 `POST /v1/provider/chat` 通过请求头 `x-web-providers-session-id` 识别会话；未提供时会落到默认会话 `__default__`。
- 内部 `pi` 入口 `POST /internal/pi/provider/chat` 使用 `x-pi-session-id`，并把绑定关系隔离到各自的 `pi` 会话内。
- 运行时实际保存的是 `sessionId -> provider -> BoundSession(tabId)`，所以“是不是同一个 tab”取决于是否命中同一个绑定会话。
- 当前没有按 `requestId` 或幂等键做重复请求去重。一次请求结束后，后续重试会再次真正执行；如果上一个请求仍在运行，则会返回 `MODEL_BUSY`。
- `conversationId` 是 helper 本地逻辑 ID，不是远端网页真实会话 ID，不能据此恢复历史网页对话。

## 🛠️ 技术栈

- **Runtime**: Node.js (ESM)
- **Framework**: Fastify
- **Language**: TypeScript
- **Testing**: Vitest

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
- 当前公开模型：`deepseek-web-pro`、`deepseek-web-flash`、`qwen-web-chat`、`qwen-web-tools`

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

## Claude Code / cc switch 使用方案

如果你希望把 `Claude Code` 切到本地 `web-providers` 网关，当前仓库提供的是 `Anthropic Messages` 兼容入口，而不是 OpenAI 入口。接入时需要把 Claude Code 的 `base URL` 指向本地网关，并让它走 `POST /v1/messages`。

### 1. 启动网关

建议显式配置统一 token，避免 OpenAI/Anthropic 两套入口鉴权不一致：

```bash
GATEWAY_TOKEN=dev-token npm run dev
```

默认情况下：
- 网关地址是 `http://127.0.0.1:4321`
- Claude Code 应走 `Anthropic` 风格鉴权头 `x-api-key: dev-token`
- 真正执行请求的是 `POST /v1/messages`

### 2. 在 cc switch 中切到本地网关

`cc switch` 的核心是把 Claude Code 当前使用的 provider/base URL 切到你的本地服务。无论你是通过配置文件、环境变量还是 `cc switch` 的交互式配置完成切换，目标都应保持一致：

- `Base URL`：`http://127.0.0.1:4321`
- `API Key`：`dev-token`
- 协议类型：`Anthropic`

如果你的 `cc switch` 支持直接填写模型名，使用本仓库当前公开模型之一：

- `deepseek-web-pro`
- `deepseek-web-flash`
- `qwen-web-chat`
- `qwen-web-tools`

不再使用旧的 `anthropic-*` 别名。

### 3. 会话复用方式

Claude Code 请求头里的 `x-claude-code-session-id` 会被网关自动转成内部的 `x-web-providers-session-id`，因此同一个 Claude Code session 会复用同一个已绑定网页会话。

这意味着：
- 同一条 Claude Code 会话内，标题生成请求和正式对话请求会落到同一个绑定 tab
- 不需要客户端自己传 `tabId`
- 如果同一个 `sessionId + provider` 已有请求进行中，并发请求会返回 `MODEL_BUSY`

### 4. 连通性自检

切换后可以先验证模型列表和健康状态：

```bash
curl http://127.0.0.1:4321/v1/health
```

```bash
curl -H 'x-api-key: dev-token' http://127.0.0.1:4321/v1/models
```

如果 `cc switch` 已正确切到本地网关，Claude Code 发起对话时会命中本地 `POST /v1/messages`，再由网关转发到内部 helper/browser provider 链路。

## 🛠️ 技术栈

- **Runtime**: Node.js (ESM)
- **Framework**: Fastify
- **Language**: TypeScript
- **Testing**: Vitest

# Web Providers

**Web Providers** 是一个基于 Fastify 的轻量级后端服务，旨在将网页版 AI 模型（如 DeepSeek、Qwen 等）桥接为标准 API 接口。它通过维护本地 `sessionId -> provider -> browser tab` 的绑定关系，并转译页面状态与回复结果，让开发者能以 API 形式调用网页版 AI 的能力。

## ⚙️ 环境准备

在使用本项目前，请确保已全局安装以下依赖：

```bash
npm install -g bb-browser
npm install -g @mariozechner/pi-coding-agent
```

> 注意：`pi-coding-agent` 的正确包名为 `@mariozechner/pi-coding-agent`

## 🚀 使用方式

确保满足上述依赖后，在项目根目录下直接执行 `pi` 命令：

```bash
pi
```

## ✨ 特性

- 🚀 **多提供商支持**: 目前已支持 `deepseek-web` 和 `qwen-web`，架构易于扩展。
- 🔌 **API 网关**: 提供 helper 路由 (`/v1/chat`, `/v1/provider/chat`) 和 OpenAI 风格适配入口。
- 🔒 **会话绑定**: 通过本地会话头把请求绑定到已发现的浏览器 tab，而不是让客户端直接传 `tabId`。
- 🚦 **请求串行化**: 同一 `sessionId + provider` 在同一时间只允许一个进行中的请求，并发请求会返回 `MODEL_BUSY`。
- 🛡️ **类型安全**: 全面使用 TypeScript 和 TypeBox 进行数据校验。
- 📊 **监控与健康检查**: 内置 `/v1/health` 端点，实时监测服务与浏览器连接状态。

## 📖 API 概览

| 方法 | 路径 | 描述 |
|------|------|------|
| `POST` | `/v1/bind` | 绑定并初始化 AI 提供商页面会话 |
| `POST` | `/v1/chat` | 发送聊天请求 |
| `POST` | `/v1/provider/chat` | 高级提供商聊天接口 (支持工具调用) |
| `POST` | `/v1/reset` | 重置指定提供商状态 |
| `GET`  | `/v1/health` | 检查服务及浏览器连接健康状态 |

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

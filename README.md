# Web Providers

**Web Providers** 是一个基于 Fastify 的轻量级后端服务，旨在将网页版 AI 模型（如 DeepSeek、Qwen 等）桥接为标准 API 接口。通过管理浏览器会话和页面通信，让开发者能方便地调用网页版 AI 的能力。

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
- 🔌 **API 网关**: 提供 RESTful 接口 (`/v1/chat`, `/v1/provider/chat`)，兼容标准 OpenAI 风格调用。
- 🔒 **会话管理**: 灵活的 Tab 绑定 (`/v1/bind`) 和状态管理机制，支持多会话并发。
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

## 🛠️ 技术栈

- **Runtime**: Node.js (ESM)
- **Framework**: Fastify
- **Language**: TypeScript
- **Testing**: Vitest

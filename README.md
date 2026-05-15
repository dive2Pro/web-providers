# Web Providers

**Web Providers** 是一个基于 Fastify 的轻量级后端服务，旨在将网页版 AI 模型（如 DeepSe 等）桥接为标准 API 接口。 让开发者能以 API 形式调用网页版 AI 的能力。

## ⚙️ 环境准备

在项目根目录安装依赖后再启动服务：

```bash
pnpm install
```


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
 
## Claude Code / cc switch 使用方案

### 1. 启动网关

建议显式配置统一 token，避免鉴权不一致：

```bash
GATEWAY_TOKEN=dev-token npm run dev
```

默认情况下：
- 网关地址是 `http://127.0.0.1:4321`

### 2. 在 cc switch 中切到本地网关

`cc switch` 的核心是把 Claude Code 当前使用的 provider/base URL 切到你的本地服务。无论你是通过配置文件、环境变量还是 `cc switch` 的交互式配置完成切换，目标都应保持一致：

- `Base URL`：`http://127.0.0.1:4321`
- `API Key`：`dev-token`
- 协议类型：`Anthropic`

支持的模型名：

- `deepseek-web-pro`
- `deepseek-web-flash`

## Electron 桌面包装

当前仓库现在也支持作为 Electron 桌面应用运行。桌面壳会在 Electron 主进程里直接启动 helper 和 gateway，并在界面中展示 `Claude Code` 的连接信息。

常用命令：

```bash
npm run desktop:start
```

- `npm run desktop:start`: 构建并启动本地 Electron 应用
- `npm run desktop:pack`: 生成当前平台的未打包目录版本，适合本地验收
- `npm run desktop:dist`: 生成 Electron Builder 发行产物，默认关闭自动签名发现，避免被本机证书状态卡住

桌面应用会持久化以下内容：

- 端口与网关 token：Electron 的 `userData/desktop-config.json`
- 请求日志：Electron 的 `userData/desktop-runtime/request-logs/`
- 会话绑定：Electron 的 `userData/desktop-runtime/session-bindings/`

在桌面应用中使用 `Claude Code` 时，继续按以下信息配置即可：

- `Protocol`: `Anthropic`
- `Base URL`: 桌面应用里显示的网关地址，默认 `http://127.0.0.1:4321`
- `API Key`: 桌面应用里显示的 gateway token

## 🛠️ 技术栈

- **Runtime**: Node.js (ESM)
- **Framework**: Fastify
- **Language**: TypeScript
- **Testing**: Vitest

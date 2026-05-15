# Electron + Claude Code Wrap Contract

## 目标

把当前仓库的本地服务包装成一个 Electron 桌面应用，并把 `Claude Code` 的外部连接引导一并纳入桌面应用内。

## 交付物

- 一份确认后的实现方案
- 可打包的 Electron 桌面应用骨架
- 服务启动/停止与 `Claude Code` 外部连接引导的可运行链路

## 范围

允许变更：

- 新增 Electron 主进程与渲染进程入口
- 现有服务启动方式、进程管理、端口配置、窗口 UI
- 与 `Claude Code` 连接相关的配置入口或引导流程

暂不默认包含：

- 重写当前 Fastify 网关业务逻辑
- 重写浏览器自动化能力
- 重新设计所有 API 协议

## 基线

- 当前仓库是一个 Node.js + TypeScript 的本地网关服务项目
- `package.json` 当前只有服务和测试脚本，没有 Electron 入口
- README 已说明服务默认监听 `127.0.0.1:4321`，helper 默认 `127.0.0.1:4318`
- 目前仓库里没有现成的桌面壳或前端 UI

## 真实链路

本轮采用的真实链路是：

1. Electron 负责桌面壳与进程编排，内部启动现有 helper 与 gateway
2. `Claude Code` 继续作为外部 CLI，通过 Electron UI 展示的网关信息连接本地服务

## 验证方式

完成标准至少包括：

- Electron 能启动并显示一个窗口
- 当前服务能在 Electron 生命周期内正常启动
- 桌面应用中能展示清晰的 `Claude Code` 连接信息和操作指引

## 已确认项

- 用户希望把“当前的服务”和 `Claude Code` 一起考虑为 Electron 应用的一部分
- 当前仓库本身是服务端项目，不是现成桌面应用
- 用户已确认选择 `2 / 2 / 1`：
  - Electron 提供 `Claude Code` 启动/配置引导，但不真正内置它
  - 本轮交付可打包桌面应用骨架
  - `Claude Code` 仍作为外部 CLI 使用

## 已核实项

- `package.json` 只有 `dev`/`build`/`test` 等 Node 脚本，没有 Electron 相关依赖
- 主要运行入口是 `src/helper/main.ts` 和 `src/gateway/main.ts`
- 网关默认端口为 `4321`，helper 默认端口为 `4318`
- 当前工作区有未提交改动，且应避免回退非本次改动内容

## 推断项

- Electron 主进程内直接托管 Fastify 实例，会比额外派生 Node 守护进程更易打包
- `Claude Code` 的最佳落点是外部 CLI + 桌面应用配置引导，而不是在本轮内深度内嵌

## 待确认项

无

## 当前状态

已进入实现，目标是交付独立 `desktop:*` 构建链路、Electron UI、服务生命周期托管与 `Claude Code` 配置引导。

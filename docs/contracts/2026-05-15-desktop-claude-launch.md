# Desktop Claude Command Contract

## 目标

- 移除 desktop 中“修改端口”的能力。
- 增加一个从 desktop 复制 Claude Code 启动命令的能力，并在命令中注入连接所需环境变量。

## 交付物

- Desktop 主进程、preload、renderer 的代码改动。
- 与 desktop 配置/引导相关的共享逻辑调整。
- 基本运行验证与测试结果说明。

## 范围

- 允许变更 `electron/` 下 desktop 相关代码。
- 允许变更 `src/shared/desktop-config.ts` 及相关测试。
- 暂不触碰 helper / gateway 协议实现，除非为复制 Claude Code 启动命令必须补充环境变量映射。

## 基线

- 当前 desktop UI 在 [electron/renderer/index.html](/Users/yc/code/webai-no-fee/electron/renderer/index.html) 中提供 `Gateway Port`、`Helper Port`、`Gateway Token` 三项设置。
- 当前 desktop renderer 在 [electron/renderer/app.js](/Users/yc/code/webai-no-fee/electron/renderer/app.js) 中通过 `saveSettings()` 保存上述设置，并通过 `restartServices()` 重启服务。
- 当前 desktop 配置定义在 [src/shared/desktop-config.ts](/Users/yc/code/webai-no-fee/src/shared/desktop-config.ts)，端口属于持久化配置。
- 当前 Claude Code 区块只展示协议、Base URL、API Key 和手动配置步骤，没有“复制 Claude Code 启动命令”能力。

## 真实链路

- Electron 主进程在 [electron/main.ts](/Users/yc/code/webai-no-fee/electron/main.ts) 中启动 helper/gateway 服务并创建窗口。
- preload 在 [electron/preload.ts](/Users/yc/code/webai-no-fee/electron/preload.ts) 暴露 renderer 可调用的 desktop API。
- renderer 在 [electron/renderer/app.js](/Users/yc/code/webai-no-fee/electron/renderer/app.js) 调用 desktop API 并渲染桌面界面。

## 验证方式

- Desktop 构建成功并可启动。
- Desktop UI 不再提供端口修改入口。
- Desktop 中可复制 Claude Code 启动命令，并带上约定的环境变量。
- 相关测试通过；若存在仓库既有失败，需要单独标注。

## 已确认项

- 用户希望移除“修改端口”的功能。
- 用户希望提供一个“复制 Claude Code 启动命令”的功能，并在命令中写入环境变量。
- 用户确认 UI 中不再允许修改端口。
- 用户要求默认端口被占用时自动选择其他可用端口。
- 用户确认 `Copy Claude Command` 旁边放一个 model 下拉框。
- 用户要求复制出的命令把 Claude Code 的所有模式统一映射到所选 model。

## 已核实项

- 当前默认 helper/gateway 端口分别为 `4318` / `4321`。
- 当前配置允许修改端口，且会保存到用户配置文件中。
- 当前桌面端没有复制外部 CLI 启动命令的实现。
- 当前工作区有未提交改动：`.web-providers/request-logs/helper.ndjson`。

## 推断项

- 用户仍然允许修改 `gateway token`，只是不要再改端口。
- 用户复制命令后会在自己的 shell 环境中粘贴执行，而不是由 Electron 直接托管 CLI 生命周期。

## 待确认项

- 无

## 当前状态

- 已完成项目现状核实与最终需求确认。
- 已实施：移除端口编辑、保留自动端口回退、增加 Claude Code 命令复制入口。
- 已追加收口：主视图默认只展示 gateway 信息，helper 信息下沉到 debug 区。
- 已追加收口：复制命令前可在 UI 中选择 model，复制命令时统一映射所有 Claude 模式到该 model。

# Startup Port Logging Contract

## 目标

在本仓库各服务启动时输出监听地址与关键接口信息，方便用户确认当前服务实际绑定的端口。

## 交付物

- 一份已确认的需求合约
- 各服务启动入口的端口输出日志

## 范围

允许变更：

- `src/helper/main.ts`
- `src/openai-adapter/main.ts`
- `src/anthropic-adapter/main.ts`
- `src/gateway/main.ts`

## 基线

- 当前各启动入口只执行 `app.listen(...)`
- 当前启动完成后不会主动输出监听地址

## 真实链路

服务启动后，由各自 `main.ts` 在 `listen()` 成功返回后打印当前监听地址和关键接口前缀。

## 验证方式

- 启动任一服务时，终端可看到监听地址
- OpenAI/Anthropic/gateway 服务启动时可看到对应接口前缀

## 已确认项

- 用户希望“启动服务时提供接口端口信息”

## 已核实项

- `helper`、`openai-adapter`、`anthropic-adapter`、`gateway` 均有独立 `main.ts`
- 当前这些入口都没有启动日志

## 推断项

- 无

## 待确认项

- 无

## 当前状态

开始实现启动日志输出。

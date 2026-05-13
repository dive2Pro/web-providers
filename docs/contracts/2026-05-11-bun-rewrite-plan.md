# Bun Rewrite Plan Contract

## 目标

为当前 `web` 服务制定一份基于 Bun 的重写方案，覆盖推荐架构、迁移阶段、验证策略、风险点与待确认决策，不在本轮直接实施代码改造。

## 交付物

- 一份面向当前仓库现状的 Bun 重写方案
- 一份可追踪的需求合约，用于约束后续是否进入实际迁移

## 范围

允许变更：

- 方案设计
- 现状分析
- 需求合约留档

不在本轮范围：

- 实际代码迁移
- 依赖替换
- 测试改写
- 启动脚本改造
- 发布流程改造

## 基线

- 当前仓库：`/Users/yc/code/webai-no-fee`
- 当前依赖栈：`Fastify + TypeScript + tsx + Vitest`
- 当前服务拓扑：
  - `src/helper/*` 为状态与浏览器自动化编排层
  - `src/openai-adapter/*` 为 OpenAI 兼容 API 层
- 当前开发链路：`scripts/dev-openai-stack.sh` 以两个端口启动 helper 与 adapter

## 真实链路

当前真正的请求路径为：

1. 外部请求进入 `openai-adapter`
2. `openai-adapter` 将标准化请求转发到 `helper`
3. `helper` 调用 `HelperRuntime`
4. `HelperRuntime` 通过 `bb-browser` CLI 驱动网页提供商

## 验证方式

本轮以“方案正确性”作为完成标准，而不是以运行结果作为完成标准。验证方式：

- 方案必须基于已核实的代码结构，而不是抽象假设
- 方案必须说明迁移边界、阶段拆分、测试策略和回滚策略
- 方案必须显式列出待确认项

## 已确认项

- 用户希望将 web 服务使用 Bun 进行重写
- 用户当前要的是“方案”，不是直接开始改造

## 已核实项

- 仓库存在两个 HTTP 服务入口：`src/helper/main.ts` 与 `src/openai-adapter/main.ts`
- 两个入口都使用 `Fastify`
- `openai-adapter` 通过 `fetch` 调用 `helper`
- `helper` 的核心状态保存在 `HelperState`
- `helper` 的核心执行逻辑在 `HelperRuntime`
- `helper` 依赖 `node:child_process` 调用 `bb-browser`
- `helper` 已直接挂载 `/v1/models`、`/v1/chat/completions`、`/v1/responses`
- 仓库已有 `tests/helper/merged-openai.test.ts` 验证 merged OpenAI 路由
- 当前测试大量依赖 `Fastify.inject()`
- 当前工作区有未跟踪文件：`pnpm-lock.yaml`

## 推断项

- 用户提到的 “web 服务” 大概率指 `helper + openai-adapter` 这一整组 HTTP 服务，而不是浏览器插件端
- 用户更需要的是“逐步迁移方案”，而不是一次性推倒重写
- 由于 merged OpenAI 路由已经存在，Bun 重写的主目标更适合收敛到 `helper` 单服务，而不是继续维持 `adapter -> helper` 双跳

## 待确认项

1. 决策名：重写范围
   - 选项 1（推荐）：以 `helper` 为主干，迁移到 Bun 后正式收敛成单一服务，并将 `openai-adapter` 退化为兼容层或删除。代价是需要调整现有启动与测试基线，但仓库已有 merged 路由基础。
   - 选项 2：继续保留 `helper + openai-adapter` 双服务，只替换 HTTP 运行时。代价是迁移更保守，但继续保留一次内部转发。

2. 决策名：迁移目标
   - 选项 1（推荐）：先实现 “Bun runtime + Bun.serve + 保留 TypeScript 代码组织”，以兼容现有逻辑为优先。代价是不会立刻吃满 Bun 的全部生态收益。
   - 选项 2：同时迁移运行时、包管理、测试与脚本体系，全面 Bun 化。代价是收益更完整，但范围显著扩大。

3. 决策名：测试策略
   - 选项 1（推荐）：首阶段保留 `Vitest`，仅替换 Fastify 专属测试方式。代价是工具链混用一段时间。
   - 选项 2：同步迁移到 `bun test`。代价是测试语义、mock 行为与现有断言辅助都要重新校准。

## 当前状态

已完成现状核查，正在输出基于当前事实的 Bun 重写方案；尚未进入实施阶段。

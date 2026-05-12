# 合约：DeepSeek Pro/Flash 与模型别名收敛

## 目标

将 DeepSeek 的公开模型语义从旧的 `deepseek-web-chat` / `deepseek-web-tools` 收敛为新的 `deepseek-web-pro` 与 `deepseek-web-flash`，并同步移除 `anthropic-*` 前缀模型暴露。

## 交付物

- 公开模型列表仅展示：
  - `deepseek-web-pro`
  - `deepseek-web-flash`
  - `qwen-web-chat`
  - `qwen-web-tools`
- Anthropic 路由继续存在，但不再暴露或接受 `anthropic-*` 模型别名
- DeepSeek 新会话按模型默认切换页面模式：
  - `deepseek-web-pro` -> 专家模式
  - `deepseek-web-flash` -> 非专家 / 默认模式
- 旧 `deepseek-web-chat`、`deepseek-web-tools` 作为隐藏兼容名保留请求入口

## 范围

- 允许变更：
  - `src/openai-adapter/*`
  - `src/anthropic-adapter/*`
  - `src/gateway/*`
  - `src/helper/*`
  - 相关测试与 README
- 不改：
  - 其他 provider 的公开命名
  - 非 DeepSeek 的页面自动化逻辑

## 基线

- 当前仓库此前已完成：
  - Anthropic `/v1/messages` 路由接入
  - `anthropic-*` 模型移除
- 当前工作区仍有其他未提交本地改动，实施时只叠加与本合约相关的修改

## 真实链路

`/v1/models` or `/v1/messages` or `/v1/chat/completions`
-> model registry / normalize
-> helper `/v1/provider/chat`
-> `HelperRuntime`
-> `BbBrowserClient.startNewChat(...)`
-> DeepSeek 页面桥接切换目标模式

## 验证方式

- `/v1/models` 与 Anthropic `/v1/models` 不再返回 `anthropic-*`
- 公共模型列表返回 `deepseek-web-pro` 与 `deepseek-web-flash`
- `anthropic-deepseek-web-chat` 请求返回 `Unknown model`
- DeepSeek `pro/flash` 与兼容别名都可携带 tools
- DeepSeek 新会话测试覆盖到专家模式切换
- DeepSeek 模式切换优先依据页面真实组件结构定位，而不是只依赖中英文文案

## 已确认项

- DeepSeek 默认覆盖范围仅限 `deepseek-web`
- 新模型名采用 `deepseek-web-pro` 与 `deepseek-web-flash`
- 专家模式作用于 DeepSeek 默认路径
- 只在新会话初始化时切换模式
- `anthropic-*` 模型需要移除
- 页面匹配规则改为“组件位置优先，文案兜底”
- 目标页面以用户提供的中文界面形态为准

## 已核实项

- `anthropic-*` 原本只是 `anthropic-adapter/models.ts` 基于公共模型动态生成的别名前缀
- DeepSeek 页面桥接已能从 SSE 读到 `model_type`
- helper 绑定维度已支持按 DeepSeek `modelId` 区分会话
- DeepSeek 根页主模式切换当前是输入框上方的一组 `role=radio` 控件，顺序为默认/快速在前、专家在后
- 输入框下方的“深度思考 / 智能搜索”是另一组 toggle，不应替代上方主模式组

## 推断项

- 无

## 待确认项

- 无

## 当前状态

- 已按本合约推进模型注册、Anthropic 别名清理、DeepSeek 模式切换与回归测试更新
- 后续用户补充要求：恢复 DeepSeek tools 支持；当前实现已按该口径放开
- 当前新增约束已纳入实现：优先按 HTML 结构定位 DeepSeek 根页主模式组，并补充中文页面与无标签匹配回归测试

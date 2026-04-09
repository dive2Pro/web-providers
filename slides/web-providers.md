---
theme: default
title: web-providers
titleTemplate: "%s"
info: 把网页端模型能力接入 code agent
author: Codex
class: text-left
transition: slide-left
mdc: true
lineNumbers: false
drawings:
  persist: false
exportFilename: pi-provider-bb-browser-sharing
setup: |
  import { GithubIcon } from 'lucide-vue-next'
---

<div class="absolute inset-0 bg-gradient-to-br from-slate-950 via-slate-900 to-amber-950 opacity-95"></div>
<div class="absolute left-8 top-8 h-24 w-24 rounded-full bg-amber-300/10 blur-2xl"></div>
<div class="absolute bottom-10 right-10 h-28 w-28 rounded-full bg-cyan-300/10 blur-3xl"></div>

<div class="relative z-10 flex h-full flex-col justify-between text-stone-100">
  <div>
    <div class="inline-flex rounded-full border border-amber-300/30 px-4 py-1 text-xs uppercase tracking-[0.3em] text-amber-200">
      <GithubIcon class="w-3 h-3 mr-1" /> · github.com/dive2Pro/web-providers
    </div>
    <h1 class="mt-6 text-5xl font-black leading-tight tracking-tight">
      web-providers
    </h1>
    <p class="mt-4 max-w-3xl text-xl leading-relaxed text-stone-300">
      把网页端模型能力接入 code agent
    </p>
  </div>
</div>

---
layout: two-cols
---

# Code Agent 是什么

- 可以把它理解成一个会自己干活的终端助手
- 你给它目标，它不会只回一句话，而是会继续拆步骤
- 它会决定读文件、跑命令、调工具，还是继续问模型
- 它真正有用的地方，不是会聊，而是会一轮一轮往下执行

::right::

<div class="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
  <div class="text-xs uppercase tracking-[0.25em] text-slate-500">拆开看，主要就是这几层</div>
  <div class="mt-4 grid gap-3 text-lg">
    <div class="rounded-2xl bg-white p-3">接用户输入</div>
    <div class="rounded-2xl bg-white p-3">决定下一步干什么</div>
    <div class="rounded-2xl bg-white p-3">调模型和工具</div>
    <div class="rounded-2xl bg-white p-3">调工具再回来继续</div>
  </div>
</div>

---
layout: full
---

# Code Agent 是怎么跑的

```mermaid {scale: 0.64}
flowchart TD
    U[用户输入] --> A[Agent 运行循环<br/>读上下文 / 做决策]
    A --> M[问模型<br/>下一步该做什么]
    A --> T[工具与扩展]
    T --> A
    M --> A
    A --> O[产出结果]
```

<div class="mt-4 grid grid-cols-3 gap-3 text-sm">
  <div class="rounded-2xl border border-slate-200 bg-slate-50 p-3">先拿到目标和上下文</div>
  <div class="rounded-2xl border border-slate-200 bg-slate-50 p-3">再循环判断下一步是调工具，还是继续问模型</div>
  <div class="rounded-2xl border border-slate-200 bg-slate-50 p-3">直到把事做完，再把结果返回给用户</div>
</div>

---
layout: two-cols
---

# Pi Code Agent 是什么

- 它是一个可以自己掌控 agent 对话流程的 code agent 运行时
- 不是只能把 prompt 丢进去等返回，而是能控制每一轮怎么继续
- 什么时候继续问模型，什么时候调工具，什么时候结束，都能自己定义
- 这也是我们选择它的原因: 对流程控制权足够大

::right::

<div class="grid gap-3 text-sm">
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">能控制每一轮对话怎么往下走</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">能决定工具调用和模型调用怎么穿插</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">能把会话、状态和上下文握在自己手里</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">所以很适合接非标准的模型来源</div>
</div>

---
layout: two-cols
---

# Provider 是什么

- 可以把它理解成模型接入层的统一插槽
- 上层只管发消息、拿结果，不关心底层接的是 API 还是网页
- provider 负责把请求翻译出去，再把结果翻译回来
- 只要 provider 接口不变，上层 agent 就能继续跑

::right::

<div class="grid gap-3 text-sm">
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">统一模型列表和调用入口</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">统一消息格式和参数</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">统一返回结构和事件流</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">上层不用感知底层实现差异</div>
</div>

---
layout: two-cols
---

## 能不能开个脑洞

- 既然网页上已经能直接对话，那能不能别只让人手动用
- 能不能把这份能力接进 code agent，让它也能调起来
- 如果要接进去，对上层来说最好还是一个标准 provider
- 这样 agent 根本不用知道背后其实是网页

::right::

<div class="rounded-3xl border border-amber-200 bg-amber-50 p-6 shadow-sm">
  <div class="text-sm leading-8 text-slate-700">
    这里真正的问题是：
  </div>
  <div class="mt-4 text-3xl font-black leading-tight text-slate-900">
    能不能把网页端对话，
    <br>
    伪装成一个 provider？
  </div>
  <div class="mt-4 text-sm leading-7 text-slate-600">
    如果可以，上层还是按 provider 去调，
    <br>
    只是底层从官方 API 变成了网页会话。
  </div>
</div>

---
layout: center
class: text-center
---

<div class="flex h-full flex-col items-center justify-center">
  <div class="rounded-full border border-amber-300/30 px-4 py-1 text-xs uppercase tracking-[0.3em] text-amber-700">
    Demo Time
  </div>
  <h1 class="mt-6 text-6xl font-black tracking-tight text-slate-900">
    Demo Time
  </h1>
  <p class="mt-4 text-xl text-slate-600">
    下面看它是怎么真的跑起来的
  </p>
</div>

---
layout: two-cols
---

# 当前 Provider 在做什么

- 把 code agent 送下来的上下文整理成模型能吃的输入
- 告诉运行时这里有哪些模型、怎么调用
- 把返回结果整理回 code agent 能认识的结构
- 让上层继续按同一种方式消费结果

::right::

<div class="grid gap-3 text-sm">
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">整理消息和上下文</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">补上初始化信息和调用参数</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">把请求交给 helper / browser worker</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">把结果转回 text / tool / thinking</div>
</div>

---
layout: full
---

<div class="px-8 py-6">
  <h1>一次调用如何从 Code Agent 走到 Provider</h1>
  <div class="mt-4 grid grid-cols-5 gap-3 text-sm leading-6">
    <div class="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div class="text-xs uppercase tracking-[0.2em] text-slate-500">1</div>
      <div class="mt-2 text-base font-semibold text-slate-900">Code Agent</div>
      <div class="mt-2 text-slate-600">发起 `streamSimple(model, context)`</div>
    </div>
    <div class="rounded-3xl border border-slate-200 bg-slate-50 p-4 shadow-sm">
      <div class="text-xs uppercase tracking-[0.2em] text-slate-500">2</div>
      <div class="mt-2 text-base font-semibold text-slate-900">Local Provider</div>
      <div class="mt-2 text-slate-600">整理消息、拼 session 初始化参数</div>
    </div>
    <div class="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div class="text-xs uppercase tracking-[0.2em] text-slate-500">3</div>
      <div class="mt-2 text-base font-semibold text-slate-900">Helper</div>
      <div class="mt-2 text-slate-600">接收 `/v1/provider/chat`，转成统一请求</div>
    </div>
    <div class="rounded-3xl border border-slate-200 bg-slate-50 p-4 shadow-sm">
      <div class="text-xs uppercase tracking-[0.2em] text-slate-500">4</div>
      <div class="mt-2 text-base font-semibold text-slate-900">Browser Worker</div>
      <div class="mt-2 text-slate-600">把 prompt 发到网页会话，等待分片结果</div>
    </div>
    <div class="rounded-3xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
      <div class="text-xs uppercase tracking-[0.2em] text-amber-700">5</div>
      <div class="mt-2 text-base font-semibold text-slate-900">返回 Code Agent</div>
      <div class="mt-2 text-slate-600">结果被整理回 provider 响应，再转成 assistant 事件</div>
    </div>
  </div>

  <div class="mt-4 rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-sm">
    <div class="flex items-center justify-between text-sm font-medium text-slate-700">
      <span>Code Agent</span>
      <span>→</span>
      <span>Local Provider</span>
      <span>→</span>
      <span>Helper</span>
      <span>→</span>
      <span>Browser Worker</span>
      <span>→</span>
      <span>网页会话</span>
      <span>→</span>
      <span>返回 Code Agent</span>
    </div>
  </div>
</div>

---
layout: two-cols
---

# 这和真实 API 调用有什么不同

- 官方 API 是直接调模型服务
- 现在这套不是直连服务，而是把网页对话能力接进来
- 所以难点不在发请求，而在网页状态、结果转译和异常恢复

::right::

<div class="grid grid-cols-2 gap-3 text-sm">
  <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
    <div class="text-xs uppercase tracking-[0.25em] text-slate-500">官方 API</div>
    <ul class="mt-3 leading-7">
      <li>程序直接请求模型服务</li>
      <li>协议稳定，输入输出都比较标准</li>
      <li>返回结果本来就是给程序消费的</li>
    </ul>
  </div>
  <div class="rounded-2xl border border-amber-200 bg-amber-50 p-4">
    <div class="text-xs uppercase tracking-[0.25em] text-amber-700">当前方案</div>
    <ul class="mt-3 leading-7">
      <li>程序先去驱动网页会话</li>
      <li>再把网页结果整理成 provider 响应</li>
      <li>本质是在把网页能力包装成 API 能力</li>
    </ul>
  </div>
</div>


---
layout: two-cols
---

# 这个工具的价值

::right::

<div class="grid gap-3 text-sm">
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">适合编码任务，也适合翻译、新闻抓取、信息整理</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">网页端对话能力可以被 CLI 和 agent 直接调用</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">把“人在网页里用”变成“程序里能调”</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">还能把不同网页来源的能力聚合到一条链路里</div>
</div>

::left::

<div class="flex h-full flex-col justify-center">
  <div class="text-6xl font-black tracking-tight text-slate-900">
    白嫖
  </div>
  <div class="mt-4 max-w-md text-xl leading-relaxed text-slate-600">
    最新网页端模型能力，
    <br>
    被收进 CLI 和 agent 工作流里。
  </div>
</div>



---
layout: two-cols
---

# 当前项目缺陷与边界

- 不能恢复真实历史对话
- 目前只支持文字对话
- 单请求串行，并发能力弱
- 强依赖页面结构和页面协议
- 恢复和调试能力有限

::right::

<div class="grid gap-3 text-sm">
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">会话恢复能力不足</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">多模态输入链路未打通</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">MODEL_BUSY 单请求约束</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">页面改版风险高</div>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">恢复和 debug 还偏初级</div>
</div>

---
layout: end
---

# 总结

<div class="mt-8 grid grid-cols-3 gap-4 text-left text-white">
  <div class="rounded-3xl border border-white/15 bg-white/8 p-5 backdrop-blur-sm">
    <div class="text-xs uppercase tracking-[0.25em] text-slate-300">Pi</div>
    <div class="mt-3 text-xl font-semibold text-white">定义统一抽象与交互语义</div>
  </div>
  <div class="rounded-3xl border border-white/15 bg-white/8 p-5 backdrop-blur-sm">
    <div class="text-xs uppercase tracking-[0.25em] text-slate-300">Provider</div>
    <div class="mt-3 text-xl font-semibold text-white">把能力接进运行时</div>
  </div>
  <div class="rounded-3xl border border-white/15 bg-white/8 p-5 backdrop-blur-sm">
    <div class="text-xs uppercase tracking-[0.25em] text-slate-300">价值</div>
    <div class="mt-3 text-xl font-semibold text-white">把网页能力收进 CLI 和 agent</div>
  </div>
</div>
 
# Pi Principles Slidev Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refocus the Slidev sharing deck from a generic bridge architecture talk to a Pi-principles-first narrative: Pi core principles, provider landing, bb-browser as lower-layer support, and finally differences and limitations.

**Architecture:** Keep the Slidev toolchain as-is, but rewrite the deck storyline and on-slide copy so the talk starts from Pi’s provider abstraction, message/tool/thinking model, and runtime-decoupling principle. Then connect those principles to the local provider implementation and explain bb-browser as the enabling lower-layer technology rather than a co-equal headline topic.

**Tech Stack:** Slidev, Markdown, Mermaid, npm

---

### Task 1: Rewrite the deck structure around Pi principles

**Files:**
- Modify: `slides/web-providers.md`
- Reference: `docs/2026-04-09-deepseek-web-bridge-sharing.md`

- [ ] **Step 1: Replace the title framing**

Update the cover and opening slides to emphasize Pi principles first, for example:

```md
# Pi 与 DeepSeek Web 接入
## 从 Pi 核心原理到 Provider 与 bb-browser
```

- [ ] **Step 2: Reorder the slide sequence**

Rewrite the body so the talk flows in this order:

```md
1. 为什么这次要先讲 Pi 的核心原理
2. Pi 的统一 provider 抽象
3. Pi 的 messages / tools / thinking / output 语义
4. Pi 的 runtime 与底层能力解耦
5. 这些原理如何落到当前 provider
6. provider 的核心逻辑
7. 一次调用如何从 Pi 走到 provider
8. 为什么 provider 还需要 bb-browser
9. bb-browser 依赖的技术核心
10. 两者如何构成当前架构
11. 和真实 API 的不同
12. 当前项目缺陷与边界
```

- [ ] **Step 3: Keep bb-browser in a support role**

Ensure bb-browser slides describe it as lower-layer support with wording like:

```md
- bb-browser 不是主角，而是让 Pi 原理在 Web 场景里成立的底层支撑
- provider 决定上层语义，bb-browser 负责把网页能力接出来
```

---

### Task 2: Refresh diagrams and slide copy

**Files:**
- Modify: `slides/web-providers.md`

- [ ] **Step 1: Update the architecture diagram labels**

Make the main architecture figure show the principle stack:

```md
Pi Runtime / Principles -> Local Provider -> Helper / bb-browser -> DeepSeek Web
```

- [ ] **Step 2: Add a Pi-principles slide**

Create a slide with three explicit principles:

```md
- 统一 provider 抽象
- 统一消息与工具调用语义
- runtime 与底层能力解耦
```

- [ ] **Step 3: Keep the final boundary slides**

Retain the “real API differences” and “project defects” sections, including:

```md
- 不能恢复真实历史对话
- 目前只支持文字对话
- 单请求串行，并发能力弱
- 强依赖页面结构和页面协议
- 恢复和调试能力有限
```

---

### Task 3: Verify the updated deck

**Files:**
- Verify: `slides/web-providers.md`
- Verify: `slides-dist/`

- [ ] **Step 1: Run the Slidev production build**

Run: `npm run slides:build`

Expected: exit code `0`

- [ ] **Step 2: Confirm the generated output still exists**

Run: `find slides-dist -maxdepth 2 -type f | sed -n '1,20p'`

Expected: `slides-dist/index.html` plus asset files

- [ ] **Step 3: Check final change scope**

Run: `git status --short .gitignore package.json package-lock.json slides docs/superpowers/plans/2026-04-09-pi-principles-slidev-refresh-plan.md`

Expected: only the planned presentation/config files are listed, plus unrelated pre-existing worktree changes outside this scoped command.

# Thinking Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate DeepSeek web thinking content from the final assistant answer in provider responses.

**Architecture:** Extend the page bridge to keep dedicated buffers for `THINK` and `RESPONSE` fragments, propagate `thinkingText` through helper contracts, and map it to assistant `thinking` content in the provider runtime. Keep the existing non-streaming helper shape and preserve current text/tool-call semantics.

**Tech Stack:** TypeScript, Fastify, Vitest, bb-browser bridge automation

---

### Task 1: Add failing tests for thinking separation

**Files:**
- Modify: `tests/helper/deepseek-page-bridge.test.ts`
- Modify: `tests/helper/provider-chat.test.ts`
- Modify: `tests/extension/index.test.ts`

- [ ] **Step 1: Write the failing tests**
- [ ] **Step 2: Run targeted tests to verify they fail for missing `thinkingText` support**
- [ ] **Step 3: Implement minimal production changes**
- [ ] **Step 4: Run targeted tests to verify they pass**

### Task 2: Propagate `thinkingText` through helper and shared contracts

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/helper/browser/types.ts`
- Modify: `src/helper/routes/provider-chat.ts`

- [ ] **Step 1: Add optional `thinkingText` to provider text and tool-call responses**
- [ ] **Step 2: Return `thinkingText` from the provider route when present**
- [ ] **Step 3: Re-run provider route tests**

### Task 3: Separate `THINK` and `RESPONSE` fragments in the page bridge

**Files:**
- Modify: `src/helper/browser/deepseek-page-bridge.ts`
- Test: `tests/helper/deepseek-page-bridge.test.ts`

- [ ] **Step 1: Track active fragment type and two output buffers**
- [ ] **Step 2: Route fragment appends and continuation chunks to the correct buffer**
- [ ] **Step 3: Return `thinkingText` alongside `outputText`**
- [ ] **Step 4: Re-run bridge tests**

### Task 4: Emit separated assistant content in the extension runtime

**Files:**
- Modify: `src/extension/provider-runtime.ts`
- Modify: `tests/extension/index.test.ts`

- [ ] **Step 1: Map helper `thinkingText` to assistant `thinking` content**
- [ ] **Step 2: Preserve existing text and tool-call event flow**
- [ ] **Step 3: Re-run extension tests**

### Task 5: Verify end-to-end behavior

**Files:**
- No code changes expected

- [ ] **Step 1: Run focused test suites covering bridge, helper route, and extension**
- [ ] **Step 2: Run the full test suite**
- [ ] **Step 3: Confirm no behavior regressions in final report**

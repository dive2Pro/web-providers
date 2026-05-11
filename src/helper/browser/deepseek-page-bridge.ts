import { HelperError } from "../errors";
import type {
  ProviderTextTurn,
  ProviderToolCall,
  ProviderToolCallTurn,
} from "./types";

export const DEEPSEEK_HOST_ALLOWLIST = new Set([
  "chat.deepseek.com",
  "www.deepseek.com",
  "deepseek.com",
]);

export function assertDeepSeekUrl(rawUrl: string) {
  const url = new URL(rawUrl);

  if (!DEEPSEEK_HOST_ALLOWLIST.has(url.host)) {
    throw new HelperError(
      "PAGE_UNAVAILABLE",
      `Unsupported DeepSeek host: ${url.host}`,
    );
  }

  return url.toString();
}

export interface CompletionRawEvent {
  eventType: string | null;
  parsed: unknown;
  at: number;
}

export type CompletionTurn =
  | Omit<ProviderTextTurn, "modelLabel">
  | Omit<ProviderToolCallTurn, "modelLabel">;

type JsonEnvelopeDetection =
  | {
      kind: "message";
      content: string;
    }
  | {
      kind: "tool_call";
      toolCall: ProviderToolCall;
    };

function normalizeToolCallArguments(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (typeof value !== "string") {
      return null;
    }

    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }

      return JSON.stringify(parsed);
    } catch {
      return null;
    }
  }

  return JSON.stringify(value);
}

function normalizeToolCallCandidate(value: unknown): ProviderToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate =
    "function" in value &&
    value.function &&
    typeof value.function === "object" &&
    !Array.isArray(value.function)
      ? value.function
      : value;

  const name =
    "name" in candidate && typeof candidate.name === "string"
      ? candidate.name.trim()
      : "";
  const argumentsJson = normalizeToolCallArguments(
    "arguments" in candidate ? candidate.arguments : undefined,
  );

  if (name.length === 0 || !argumentsJson) {
    return null;
  }

  return {
    name,
    argumentsJson,
  };
}

function findToolCallInValue(
  value: unknown,
  hintKey: string | null = null,
): ProviderToolCall | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const hinted =
    hintKey === "tool_call" ||
    hintKey === "tool_calls" ||
    hintKey === "toolCall" ||
    hintKey === "toolCalls" ||
    hintKey === "function_call" ||
    hintKey === "functionCall" ||
    hintKey === "function";

  if (hinted) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const direct = normalizeToolCallCandidate(entry);
        if (direct) {
          return direct;
        }

        const nested = findToolCallInValue(entry);
        if (nested) {
          return nested;
        }
      }
    } else {
      const direct = normalizeToolCallCandidate(value);
      if (direct) {
        return direct;
      }
    }
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findToolCallInValue(entry);
      if (nested) {
        return nested;
      }
    }

    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nested = findToolCallInValue(nestedValue, key);
    if (nested) {
      return nested;
    }
  }

  return null;
}

export function detectNativeToolCall(rawEvents: CompletionRawEvent[]) {
  for (const event of rawEvents) {
    const detected = findToolCallInValue(event.parsed, event.eventType);
    if (detected) {
      return detected;
    }
  }

  return null;
}

function detectJsonEnvelope(text: string): JsonEnvelopeDetection | null {
  function parseCandidate(candidate: string): JsonEnvelopeDetection | null {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const parsedObject = parsed as Record<string, unknown>;

    if (parsedObject.type === "message" && typeof parsedObject.content === "string") {
      return {
        kind: "message",
        content: parsedObject.content,
      };
    }

    if (parsedObject.type === "tool_call" && typeof parsedObject.name === "string") {
      const name = parsedObject.name.trim();
      if (name.length === 0) {
        return null;
      }

      if (
        !parsedObject.arguments ||
        typeof parsedObject.arguments !== "object" ||
        Array.isArray(parsedObject.arguments)
      ) {
        return null;
      }

      return {
        kind: "tool_call",
        toolCall: {
          name,
          argumentsJson: JSON.stringify(parsedObject.arguments),
        },
      };
    }

    return null;
  }

  const directMatch = parseCandidate(text);
  if (directMatch) {
    return directMatch;
  }

  const fencedMatches: JsonEnvelopeDetection[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = parseCandidate(match[1] ?? "");
    if (parsed) {
      fencedMatches.push(parsed);
    }
  }
  if (fencedMatches.length > 1) {
    return null;
  }
  if (fencedMatches.length === 1) {
    return fencedMatches[0] ?? null;
  }

  function extractEmbeddedObjects(source: string) {
    const objects: Array<{ json: string; startIndex: number }> = [];
    let depth = 0;
    let startIndex = -1;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        if (depth === 0) {
          startIndex = index;
        }
        depth += 1;
        continue;
      }

      if (char === "}") {
        if (depth === 0) {
          continue;
        }
        depth -= 1;
        if (depth === 0 && startIndex >= 0) {
          objects.push({
            json: source.slice(startIndex, index + 1),
            startIndex,
          });
          startIndex = -1;
        }
      }
    }

    return objects;
  }

  const embeddedMatches: JsonEnvelopeDetection[] = [];
  for (const entry of extractEmbeddedObjects(text)) {
    const prefix = text
      .slice(Math.max(0, entry.startIndex - 80), entry.startIndex)
      .toLowerCase();
    if (
      prefix.includes("for normal replies use:") ||
      prefix.includes("for tool calls use:")
    ) {
      continue;
    }

    const parsed = parseCandidate(entry.json);
    if (parsed) {
      embeddedMatches.push(parsed);
    }
  }

  if (embeddedMatches.length > 1) {
    return null;
  }
  if (embeddedMatches.length === 1) {
    return embeddedMatches[0] ?? null;
  }

  return null;
}

export function detectJsonFallbackToolCall(text: string) {
  const detection = detectJsonEnvelope(text);
  return detection?.kind === "tool_call" ? detection.toolCall : null;
}

export function classifyCompletionTurn(input: {
  reply: string;
  thinking?: string;
  rawEvents: CompletionRawEvent[];
}): CompletionTurn {
  const outputText = input.reply.trim();
  const thinkingText = input.thinking?.trim() ?? "";
  const nativeToolCall = detectNativeToolCall(input.rawEvents);
  if (nativeToolCall) {
    return {
      mode: "native_tool_call",
      toolCall: nativeToolCall,
      ...(thinkingText.length > 0 ? { thinkingText } : {}),
      ...(outputText.length > 0 ? { outputText } : {}),
    };
  }

  const jsonEnvelope = detectJsonEnvelope(outputText);
  if (jsonEnvelope?.kind === "tool_call") {
    return {
      mode: "json_fallback",
      toolCall: jsonEnvelope.toolCall,
      ...(thinkingText.length > 0 ? { thinkingText } : {}),
      outputText,
    };
  }

  if (jsonEnvelope?.kind === "message") {
    return {
      mode: "text",
      ...(thinkingText.length > 0 ? { thinkingText } : {}),
      outputText: jsonEnvelope.content,
    };
  }

  return {
    mode: "text",
    ...(thinkingText.length > 0 ? { thinkingText } : {}),
    outputText,
  };
}

export const INJECTED_BRIDGE_SOURCE = `
(() => {
  const KEY = "__piDeepSeekBridge";
  const VERSION = 12;
  const __name = (target, _value) => target;
  const detectNativeToolCall = ${detectNativeToolCall.toString()};
  const detectJsonEnvelope = ${detectJsonEnvelope.toString()};
  const detectJsonFallbackToolCall = ${detectJsonFallbackToolCall.toString()};
  const classifyCompletionTurn = ${classifyCompletionTurn.toString()};
  const normalizeToolCallArguments = ${normalizeToolCallArguments.toString()};
  const normalizeToolCallCandidate = ${normalizeToolCallCandidate.toString()};
  const findToolCallInValue = ${findToolCallInValue.toString()};
  const existing = window[KEY];
  if (
    existing &&
    existing.__version === VERSION &&
    typeof existing.getPageState === "function" &&
    typeof existing.submitPrompt === "function"
  ) {
    return existing;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const COMPLETION_PATH = "/api/v0/chat/completion";

  function createCompletionState() {
    return {
      observed: false,
      startedAt: 0,
      lastEventAt: 0,
      requestMessageId: null,
      responseMessageId: null,
      modelType: null,
      status: "idle",
      streamReply: "",
      thinking: "",
      rawEvents: [],
      error: null,
      closed: false,
      terminalAt: 0,
      lastPatchPath: null,
      lastPatchOp: null,
      activeFragmentType: null,
    };
  }

  const completionState = createCompletionState();

  function resetCompletionState() {
    Object.assign(completionState, createCompletionState(), {
      startedAt: Date.now(),
    });
  }

  function markCompletionObserved() {
    completionState.observed = true;
    completionState.lastEventAt = Date.now();
  }

  function markCompletionTerminal() {
    completionState.terminalAt = Date.now();
    completionState.lastEventAt = completionState.terminalAt;
  }

  function normalizeCompletionStatus(value) {
    if (typeof value !== "string") {
      return null;
    }

    if (value === "FINISHED") {
      return "finished";
    }

    if (value === "WIP") {
      return "streaming";
    }

    return value.toLowerCase();
  }

  function matchesCompletionUrl(rawUrl) {
    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      return false;
    }

    try {
      return new URL(rawUrl, window.location.href).pathname === COMPLETION_PATH;
    } catch {
      return rawUrl.includes(COMPLETION_PATH);
    }
  }

  function applyCompletionPayload(eventType, dataText) {
    if (eventType === "close") {
      completionState.rawEvents.push({
        eventType,
        parsed: null,
        at: Date.now(),
      });
      completionState.closed = true;
      markCompletionTerminal();
      if (completionState.status === "streaming" && completionState.streamReply.trim().length > 0) {
        completionState.status = "finished";
      }
      return;
    }

    if (!dataText) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(dataText);
    } catch {
      return;
    }

    markCompletionObserved();
    completionState.rawEvents.push({
      eventType,
      parsed,
      at: Date.now(),
    });

    if (eventType === "ready") {
      completionState.requestMessageId = parsed.request_message_id ?? null;
      completionState.responseMessageId = parsed.response_message_id ?? null;
      completionState.modelType = parsed.model_type ?? null;
      completionState.status = "streaming";
      return;
    }

    if (eventType === "update_session") {
      return;
    }

    const patchPath =
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.p === "string"
        ? parsed.p
        : null;
    const patchOp =
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.o === "string"
        ? parsed.o
        : null;

    if (patchPath) {
      completionState.lastPatchPath = patchPath;
    }
    if (patchOp) {
      completionState.lastPatchOp = patchOp;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.v &&
      typeof parsed.v === "object" &&
      parsed.v.response &&
      typeof parsed.v.response === "object"
    ) {
      const response = parsed.v.response;
      if (Array.isArray(response.fragments)) {
        completionState.streamReply = response.fragments
          .filter((fragment) => fragment?.type === "RESPONSE")
          .map((fragment) => (typeof fragment.content === "string" ? fragment.content : ""))
          .join("");
        completionState.thinking = response.fragments
          .filter((fragment) => fragment?.type === "THINK")
          .map((fragment) => (typeof fragment.content === "string" ? fragment.content : ""))
          .join("");
        const lastFragment = response.fragments.at(-1);
        completionState.activeFragmentType =
          lastFragment && typeof lastFragment.type === "string"
            ? lastFragment.type
            : null;
      }

      const nextStatus = normalizeCompletionStatus(response.status);
      if (nextStatus) {
        completionState.status = nextStatus;
        if (nextStatus === "finished") {
          markCompletionTerminal();
        }
      }

      return;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.p === "response/fragments" &&
      parsed.o === "APPEND" &&
      Array.isArray(parsed.v)
    ) {
      const appendedFragments = parsed.v.filter(
        (fragment) => fragment && typeof fragment === "object",
      );
      for (const fragment of appendedFragments) {
        const fragmentType =
          typeof fragment.type === "string" ? fragment.type : null;
        const fragmentContent =
          typeof fragment.content === "string" ? fragment.content : "";

        if (fragmentType === "THINK") {
          completionState.thinking += fragmentContent;
        } else if (fragmentType === "RESPONSE") {
          completionState.streamReply += fragmentContent;
        }

        completionState.activeFragmentType = fragmentType;
      }
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.p === "response/fragments/-1/content" &&
      (parsed.o === "APPEND" || !("o" in parsed)) &&
      typeof parsed.v === "string"
    ) {
      if (completionState.activeFragmentType === "THINK") {
        completionState.thinking += parsed.v;
      } else {
        completionState.streamReply += parsed.v;
      }
      completionState.status = "streaming";
      return;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      !("p" in parsed) &&
      !("o" in parsed) &&
      typeof parsed.v === "string" &&
      completionState.lastPatchPath === "response/fragments/-1/content" &&
      completionState.lastPatchOp === "APPEND"
    ) {
      if (completionState.activeFragmentType === "THINK") {
        completionState.thinking += parsed.v;
      } else {
        completionState.streamReply += parsed.v;
      }
      completionState.status = "streaming";
      return;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.p === "response/status" &&
      parsed.o === "SET"
    ) {
      const nextStatus = normalizeCompletionStatus(parsed.v);
      if (nextStatus) {
        completionState.status = nextStatus;
        if (nextStatus === "finished") {
          markCompletionTerminal();
        }
      }
      return;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.p === "response" &&
      parsed.o === "BATCH" &&
      Array.isArray(parsed.v)
    ) {
      const statusPatch = parsed.v.find(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          (entry.p === "status" || entry.p === "quasi_status"),
      );
      const nextStatus = normalizeCompletionStatus(statusPatch?.v);
      if (nextStatus) {
        completionState.status = nextStatus;
        if (nextStatus === "finished") {
          markCompletionTerminal();
        }
      }
    }
  }

  function installNetworkHook() {
    if (window.__piDeepSeekXhrHookInstalled) {
      return;
    }

    window.__piDeepSeekXhrHookInstalled = true;

    const XHR = XMLHttpRequest.prototype;
    const originalOpen = XHR.open;
    const originalSend = XHR.send;

    XHR.open = function(method, url) {
      this.__piDeepSeekUrl = url;
      return originalOpen.apply(this, arguments);
    };

    XHR.send = function(body) {
      if (matchesCompletionUrl(this.__piDeepSeekUrl)) {
        let seenLength = 0;
        let buffer = "";

        const flush = () => {
          const responseText =
            typeof this.responseText === "string" ? this.responseText : "";
          const nextChunk = responseText.slice(seenLength);
          if (nextChunk.length === 0) {
            return;
          }

          seenLength = responseText.length;
          buffer += nextChunk.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");

          let boundary = buffer.indexOf("\\n\\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 2);

            if (block.length > 0) {
              let eventType = null;
              const dataLines = [];
              for (const line of block.split("\\n")) {
                if (line.startsWith("event:")) {
                  eventType = line.slice(6).trim();
                  continue;
                }

                if (line.startsWith("data:")) {
                  dataLines.push(line.slice(5).trimStart());
                }
              }

              applyCompletionPayload(eventType, dataLines.join("\\n"));
            }

            boundary = buffer.indexOf("\\n\\n");
          }
        };

        this.addEventListener("readystatechange", () => {
          if (this.readyState === 3 || this.readyState === 4) {
            flush();
          }

          if (this.readyState === 4) {
            const trailing = buffer.trim();
            if (trailing.length > 0) {
              let eventType = null;
              const dataLines = [];
              for (const line of trailing.split("\\n")) {
                if (line.startsWith("event:")) {
                  eventType = line.slice(6).trim();
                  continue;
                }

                if (line.startsWith("data:")) {
                  dataLines.push(line.slice(5).trimStart());
                }
              }

              applyCompletionPayload(eventType, dataLines.join("\\n"));
            }

            if (completionState.status === "streaming" && completionState.streamReply.trim().length > 0) {
              completionState.status = "finished";
              markCompletionTerminal();
            }
          }
        });
      }

      return originalSend.apply(this, arguments);
    };
  }

  installNetworkHook();

  function findComposer() {
    return document.querySelector("textarea");
  }

  function detectBlockingMessage() {
    const pageText = (document.body?.innerText || "").trim();
    const path = (window.location?.pathname || "").toLowerCase();
    const normalizedText = pageText.toLowerCase();

    if (pageText.includes("One more step before you proceed")) {
      return "One more step before you proceed...";
    }

    const signInIndicators = [
      "sign in",
      "log in",
      "continue with google",
      "continue with apple",
      "forgot password",
    ];
    const authPath =
      path.includes("login") ||
      path.includes("signin") ||
      path.includes("sign-in") ||
      path.includes("auth");
    const signInPrompt = signInIndicators.some((indicator) =>
      normalizedText.includes(indicator),
    );

    if (authPath || signInPrompt) {
      return "Please sign in to DeepSeek in the browser tab.";
    }

    if (document.readyState !== "complete" && !findComposer()) {
      return "DeepSeek tab is still loading. Wait for the page to finish loading.";
    }

    return null;
  }

  function findComposerControlsRoot(composer) {
    let node = composer?.parentElement || null;
    while (node) {
      const controls = node.querySelectorAll("button, div[role='button']");
      if (controls.length > 0) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  }

  function findSendButton(composer) {
    const controlsRoot = findComposerControlsRoot(composer);
    const scopedQuery = (selector) =>
      controlsRoot?.querySelector(selector) || document.querySelector(selector);
    const nativeButton =
      scopedQuery("button[type='submit']") ||
      scopedQuery("button[aria-label='Send']") ||
      scopedQuery("button[aria-label='发送']") ||
      scopedQuery("button[data-testid='send']") ||
      scopedQuery("div[role='button'][aria-label='Send']") ||
      scopedQuery("div[role='button'][aria-label='发送']") ||
      scopedQuery("div[role='button'][data-testid='send']");

    if (nativeButton) {
      return nativeButton;
    }

    const scopedButtons = controlsRoot
      ? Array.from(controlsRoot.querySelectorAll("button, div[role='button']"))
      : [];
    const enabledScopedIconButtons = scopedButtons.filter((button) => {
      const className = (button.className || "").toString();
      const isIconButton = className.includes("ds-icon-button");
      const isDisabled =
        button.getAttribute("aria-disabled") === "true" ||
        className.includes("ds-icon-button--disabled");
      return isIconButton && !isDisabled;
    });

    if (enabledScopedIconButtons.length > 0) {
      return enabledScopedIconButtons.at(-1) || null;
    }

    const roleButtons = Array.from(document.querySelectorAll("div[role='button']"));
    const enabledIconButton = roleButtons.find((button) => {
      const className = (button.className || "").toString();
      const isIconButton = className.includes("ds-icon-button");
      const isDisabled =
        button.getAttribute("aria-disabled") === "true" ||
        className.includes("ds-icon-button--disabled");
      return isIconButton && !isDisabled;
    });

    return enabledIconButton || null;
  }

  function findStopButton() {
    return (
      document.querySelector("button[aria-label='Stop']") ||
      document.querySelector("button[aria-label='Stop generating']") ||
      document.querySelector("button[aria-label='停止']") ||
      document.querySelector("button[aria-label='停止生成']") ||
      document.querySelector("button[data-testid='stop']")
    );
  }

  function findNewChatButton() {
    const directMatch =
      document.querySelector("button[aria-label='New Chat']") ||
      document.querySelector("button[aria-label='New chat']") ||
      document.querySelector("button[aria-label='新对话']") ||
      document.querySelector("button[aria-label='新建对话']") ||
      document.querySelector("a[aria-label='New Chat']") ||
      document.querySelector("a[aria-label='新对话']") ||
      document.querySelector("[data-testid='new-chat']") ||
      document.querySelector("a[href='/']") ||
      document.querySelector("a[href='/chat']");

    if (directMatch) {
      return directMatch;
    }

    const clickableNodes = Array.from(
      document.querySelectorAll("button, a, div[role='button']")
    );
    return clickableNodes.find((node) => {
      const text = (node.textContent || "").trim().toLowerCase();
      return (
        text === "new chat" ||
        text === "new conversation" ||
        text === "新对话" ||
        text === "新建对话"
      );
    }) || null;
  }

  function setComposerValue(composer, nextValue) {
    const prototype = Object.getPrototypeOf(composer);
    const valueDescriptor =
      prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;

    if (typeof valueDescriptor?.set === "function") {
      valueDescriptor.set.call(composer, nextValue);
      return;
    }

    composer.value = nextValue;
  }

  function dispatchPromptSubmission({ prompt, method = "auto" }) {
    const composer = findComposer();
    if (!composer) {
      return { ok: false, error: "AUTOMATION_DESYNC" };
    }

    composer.focus();
    setComposerValue(composer, prompt);
    composer.dispatchEvent(new Event("input", { bubbles: true }));

    const sendButton = findSendButton(composer);
    const canClickButton = sendButton instanceof HTMLElement;
    const preferredMethod =
      method === "auto"
        ? (canClickButton ? "button" : "keyboard")
        : method;

    if (preferredMethod === "button" && canClickButton) {
      sendButton.click();
      return { ok: true, method: "button" };
    }

    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
      })
    );

    return { ok: true, method: "keyboard" };
  }

  async function waitForSubmissionStart({ baselineState, timeoutMs }) {
    const startedAt = Date.now();
    const baselineReply = (baselineState?.latestAssistantPreview || "").trim();
    const baselineAssistantCount = baselineState?.assistantCount || 0;

    while (Date.now() - startedAt < timeoutMs) {
      const pageState = window[KEY].getPageState();
      const nextText = (pageState.latestAssistantPreview || "").trim();

      if (pageState.blockingMessage) {
        return {
          ok: false,
          error: "PAGE_UNAVAILABLE",
          message: "DeepSeek requires manual verification in the browser tab before chatting",
        };
      }

      if (
        completionState.observed ||
        completionState.status !== "idle" ||
        pageState.busy ||
        pageState.assistantCount > baselineAssistantCount ||
        (nextText.length > 0 && nextText !== baselineReply)
      ) {
        return { ok: true };
      }

      await sleep(50);
    }

    return {
      ok: false,
      error: "AUTOMATION_DESYNC",
      message: "Prompt submission did not start a DeepSeek response",
    };
  }

  function latestAssistantNode() {
    const dsMessages = Array.from(document.querySelectorAll(".ds-message"));
    for (let index = dsMessages.length - 1; index >= 0; index -= 1) {
      const message = dsMessages[index];
      if (message && message.querySelector(".ds-markdown")) {
        return message;
      }
    }

    const markdownBlocks = Array.from(
      document.querySelectorAll(".ds-markdown, .markdown, [class*='markdown']")
    );
    if (markdownBlocks.length > 0) {
      return markdownBlocks.at(-1) || null;
    }

    const candidates = Array.from(
      document.querySelectorAll("[data-role='assistant'], .assistant, [data-message-author-role='assistant']")
    );
    return candidates.at(-1) || null;
  }

  function assistantMessageCount() {
    const dsMessages = Array.from(document.querySelectorAll(".ds-message"));
    const dsAssistantCount = dsMessages.filter((message) => message?.querySelector(".ds-markdown")).length;
    if (dsAssistantCount > 0) {
      return dsAssistantCount;
    }

    const markdownBlocks = document.querySelectorAll(".ds-markdown, .markdown, [class*='markdown']");
    if (markdownBlocks.length > 0) {
      return markdownBlocks.length;
    }

    return document.querySelectorAll("[data-role='assistant'], .assistant, [data-message-author-role='assistant']").length;
  }

  async function waitForReply(timeoutMs, baselineState) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const pageState = window[KEY].getPageState();
      const streamedReply = completionState.streamReply.trim();
      const streamedTurn =
        streamedReply.length > 0
          ? classifyCompletionTurn({
              reply: streamedReply,
              thinking: completionState.thinking,
              rawEvents: completionState.rawEvents,
            })
          : null;
      const terminalObserved = completionState.status === "finished" || completionState.closed;

      if (pageState.blockingMessage) {
        return {
          ok: false,
          error: "PAGE_UNAVAILABLE",
          message: "DeepSeek requires manual verification in the browser tab before chatting",
        };
      }

      if (terminalObserved && streamedTurn) {
        return {
          ok: true,
          turn: streamedTurn,
          meta: {
            source: "bridge_stream",
            completionObserved: completionState.observed,
          },
        };
      }

      await sleep(250);
    }

    const streamedReply = completionState.streamReply.trim();
    if (streamedReply.length > 0) {
      return {
        ok: true,
        turn: classifyCompletionTurn({
          reply: streamedReply,
          thinking: completionState.thinking,
          rawEvents: completionState.rawEvents,
        }),
        meta: {
          source: "bridge_timeout_recovery",
          completionObserved: completionState.observed,
        },
      };
    }

    return {
      ok: false,
      error: "TIMEOUT",
      message: "The page did not finish streaming in time",
    };
  }

  window[KEY] = {
    __version: VERSION,
    getPageState() {
      const composer = findComposer();
      const latestAssistant = latestAssistantNode();
      const blockingMessage = detectBlockingMessage();
      const domReply = latestAssistant ? (latestAssistant.textContent || "").trim() || null : null;
      return {
        inputReady: Boolean(!blockingMessage && composer),
        busy: Boolean(findStopButton()) || completionState.status === "streaming",
        latestAssistantPreview: domReply,
        assistantCount:
          completionState.observed &&
          (completionState.streamReply.trim().length > 0 ||
            completionState.responseMessageId !== null)
            ? Math.max(assistantMessageCount(), 1)
            : assistantMessageCount(),
        blockingMessage,
      };
    },
    getCompletionState() {
      const streamReply = completionState.streamReply.trim();
      return {
        observed: completionState.observed,
        status: completionState.status,
        closed: completionState.closed,
        terminalAt: completionState.terminalAt || null,
        turn:
          streamReply.length > 0
            ? classifyCompletionTurn({
                reply: streamReply,
                thinking: completionState.thinking,
                rawEvents: completionState.rawEvents,
              })
            : null,
      };
    },
    submitPrompt({ prompt }) {
      const submitted = dispatchPromptSubmission({ prompt });
      if (!submitted.ok) {
        return submitted;
      }

      return { ok: true };
    },
    async startPrompt({ prompt }) {
      const SUBMISSION_START_TIMEOUT_MS = 1200;
      const baselineState = window[KEY].getPageState();
      resetCompletionState();

      const primarySubmission = dispatchPromptSubmission({ prompt, method: "button" });
      if (!primarySubmission.ok) {
        return primarySubmission;
      }

      const primaryStart = await waitForSubmissionStart({
        baselineState,
        timeoutMs: SUBMISSION_START_TIMEOUT_MS,
      });
      if (primaryStart.ok) {
        return {
          ok: true,
          baselineState,
        };
      }

      if (primarySubmission.method === "keyboard") {
        return primaryStart;
      }

      const fallbackSubmission = dispatchPromptSubmission({ prompt, method: "keyboard" });
      if (!fallbackSubmission.ok) {
        return fallbackSubmission;
      }

      const fallbackStart = await waitForSubmissionStart({
        baselineState,
        timeoutMs: SUBMISSION_START_TIMEOUT_MS,
      });
      if (!fallbackStart.ok) {
        return fallbackStart;
      }

      return {
        ok: true,
        baselineState,
      };
    },
    async startNewChat() {
      const newChatButton = findNewChatButton();

      if (newChatButton instanceof HTMLElement) {
        newChatButton.click();
        await sleep(750);
      } else {
        window.location.href = "https://chat.deepseek.com/";
        await sleep(1_500);
      }

      resetCompletionState();
      return { ok: true };
    },
    async sendPrompt({ prompt, timeoutMs }) {
      const started = await window[KEY].startPrompt({ prompt });
      if (!started.ok) {
        return started;
      }

      const baselineState = started.baselineState;
      const submitted = started;
      if (!submitted.ok) {
        return submitted;
      }

      return waitForReply(timeoutMs, baselineState);
    },
  };

  return window[KEY];
})();
`;

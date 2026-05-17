import { HelperError } from "../errors";
import type {
  ProviderTextTurn,
  ProviderToolCallTurn,
} from "./types";
import type { ProviderToolCall } from "../../shared/contracts";

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
      kind: "tool_calls";
      toolCalls: ProviderToolCall[];
    };

function pushUniqueToolCall(
  toolCalls: ProviderToolCall[],
  toolCall: ProviderToolCall,
) {
  const key = `${toolCall.name}\u0000${toolCall.argumentsJson}`;
  if (
    toolCalls.some(
      (entry) => `${entry.name}\u0000${entry.argumentsJson}` === key,
    )
  ) {
    return;
  }

  toolCalls.push(toolCall);
}

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

function findToolCallsInValue(
  value: unknown,
  hintKey: string | null = null,
  toolCalls: ProviderToolCall[] = [],
): ProviderToolCall[] {
  if (!value || typeof value !== "object") {
    return toolCalls;
  }

  const hinted =
    hintKey === "tool_call" ||
    hintKey === "tool_calls" ||
    hintKey === "calls" ||
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
          pushUniqueToolCall(toolCalls, direct);
        }

        findToolCallsInValue(entry, null, toolCalls);
      }
    } else {
      const direct = normalizeToolCallCandidate(value);
      if (direct) {
        pushUniqueToolCall(toolCalls, direct);
      }
    }
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      findToolCallsInValue(entry, null, toolCalls);
    }

    return toolCalls;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    findToolCallsInValue(nestedValue, key, toolCalls);
  }

  return toolCalls;
}

export function detectNativeToolCalls(rawEvents: CompletionRawEvent[]) {
  const toolCalls: ProviderToolCall[] = [];

  for (const event of rawEvents) {
    findToolCallsInValue(event.parsed, event.eventType, toolCalls);
  }

  return toolCalls;
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

    if (parsedObject.type === "tool_call") {
      const toolCall = normalizeToolCallCandidate(parsedObject);
      if (!toolCall) {
        return null;
      }

      return {
        kind: "tool_calls",
        toolCalls: [toolCall],
      };
    }

    if (parsedObject.type === "tool_calls") {
      const toolCalls = findToolCallsInValue(
        "tool_calls" in parsedObject
          ? parsedObject.tool_calls
          : "toolCalls" in parsedObject
            ? parsedObject.toolCalls
            : "calls" in parsedObject
              ? parsedObject.calls
            : null,
        "tool_calls",
      );
      if (toolCalls.length === 0) {
        return null;
      }

      return {
        kind: "tool_calls",
        toolCalls,
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

export function detectJsonFallbackToolCalls(text: string) {
  const detection = detectJsonEnvelope(text);
  return detection?.kind === "tool_calls" ? detection.toolCalls : null;
}

export function classifyCompletionTurn(input: {
  reply: string;
  thinking?: string;
  rawEvents: CompletionRawEvent[];
}): CompletionTurn {
  const outputText = input.reply.trim();
  const thinkingText = input.thinking?.trim() ?? "";
  const nativeToolCalls = detectNativeToolCalls(input.rawEvents);
  if (nativeToolCalls.length > 0) {
    return {
      mode: "native_tool_call",
      toolCalls: nativeToolCalls,
      ...(thinkingText.length > 0 ? { thinkingText } : {}),
      ...(outputText.length > 0 ? { outputText } : {}),
    };
  }

  const jsonEnvelope = detectJsonEnvelope(outputText);
  if (jsonEnvelope?.kind === "tool_calls") {
    return {
      mode: "json_fallback",
      toolCalls: jsonEnvelope.toolCalls,
      ...(thinkingText.length > 0 ? { thinkingText } : {}),
      outputText,
    };
  }

  if (jsonEnvelope?.kind === "message") {
    return {
      mode: "text",
      ...(thinkingText.length > 0 ? { thinkingText } : {}),
      outputText: jsonEnvelope.content,
      rawOutputText: outputText,
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
  const VERSION = 16;
  const __name = (target, _value) => target;
  const detectNativeToolCalls = ${detectNativeToolCalls.toString()};
  const detectJsonEnvelope = ${detectJsonEnvelope.toString()};
  const detectJsonFallbackToolCalls = ${detectJsonFallbackToolCalls.toString()};
  const classifyCompletionTurn = ${classifyCompletionTurn.toString()};
  const normalizeToolCallArguments = ${normalizeToolCallArguments.toString()};
  const normalizeToolCallCandidate = ${normalizeToolCallCandidate.toString()};
  const pushUniqueToolCall = ${pushUniqueToolCall.toString()};
  const findToolCallsInValue = ${findToolCallsInValue.toString()};
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
  const VIRTUAL_LIST_ACTIVITY_WINDOW_MS = 1_500;

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
      continueAttempts: 0,
      lastContinueAt: 0,
      retryAttempts: 0,
      lastRetryAt: 0,
    };
  }

  const completionState = createCompletionState();
  const virtualListState = {
    fingerprint: null,
    lastChangedAt: 0,
  };

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

  function findVirtualListNode() {
    return document.querySelector(".ds-virtual-list-items");
  }

  function getVirtualListFingerprint(node) {
    if (!(node instanceof HTMLElement)) {
      return "";
    }

    const text = (node.textContent || "").trim();
    return JSON.stringify({
      childCount: node.childElementCount,
      textLength: text.length,
      textTail: text.slice(-200),
    });
  }

  function hasRecentVirtualListActivity() {
    const nextFingerprint = getVirtualListFingerprint(findVirtualListNode());
    if (typeof virtualListState.fingerprint !== "string") {
      virtualListState.fingerprint = nextFingerprint;
    } else if (virtualListState.fingerprint !== nextFingerprint) {
      virtualListState.fingerprint = nextFingerprint;
      virtualListState.lastChangedAt = Date.now();
    }

    return Date.now() - virtualListState.lastChangedAt < VIRTUAL_LIST_ACTIVITY_WINDOW_MS;
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
    return (
      document.querySelector("textarea") ||
      document.querySelector("[contenteditable='true'][role='textbox']") ||
      document.querySelector("[contenteditable='plaintext-only'][role='textbox']") ||
      document.querySelector("[contenteditable='true']") ||
      document.querySelector("[contenteditable='plaintext-only']") ||
      document.querySelector("div[role='textbox']")
    );
  }

  function hasInteractiveComposer() {
    const composer = findComposer();
    if (!composer) {
      return false;
    }

    return (
      composer instanceof HTMLElement &&
      (findSendButton(composer) instanceof HTMLElement ||
        findComposerControlsRoot(composer) instanceof HTMLElement)
    );
  }

  function hasLikelyDeepSeekAppShell() {
    if (hasInteractiveComposer() || findNewChatButton() || findStopButton()) {
      return true;
    }

    if (assistantMessageCount() > 0) {
      return true;
    }

    return getModeControlNodes().some((node) => {
      const label = getNodeLabel(node);
      const className = (node?.className || "").toString().toLowerCase();
      return (
        label.includes("new chat") ||
        label.includes("new conversation") ||
        label.includes("新对话") ||
        label.includes("新建对话") ||
        label.includes("expert") ||
        label.includes("deepthink") ||
        label.includes("flash") ||
        label.includes("search")
      );
    });
  }

  function detectBlockingMessage() {
    const pageText = (document.body?.innerText || "").trim();
    const path = (window.location?.pathname || "").toLowerCase();
    const normalizedText = pageText.toLowerCase();
    const composer = findComposer();
    const shellReady = hasLikelyDeepSeekAppShell();
    const hasConversationEvidence =
      Boolean(composer) ||
      Boolean(latestAssistantNode()) ||
      assistantMessageCount() > 0 ||
      Boolean(findStopButton()) ||
      shellReady;

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

    if (authPath || (signInPrompt && !hasConversationEvidence)) {
      return "Please sign in to DeepSeek in the browser tab.";
    }

    const readyState = typeof document.readyState === "string"
      ? document.readyState
      : "complete";
    const pageLooksBlank = normalizedText.length === 0;

    if ((readyState === "loading" || readyState === "interactive") && !composer && !shellReady) {
      return "DeepSeek tab is still loading. Wait for the page to finish loading.";
    }

    if (pageLooksBlank && readyState === "complete" && !composer && !shellReady) {
      return "DeepSeek finished loading an empty page in the embedded browser. Reload the page or sign in manually, then retry.";
    }

    if (pageLooksBlank && !composer && !shellReady) {
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

  function getNodeText(node) {
    if (!node) {
      return "";
    }

    if (typeof node.innerText === "string" && node.innerText.trim().length > 0) {
      return node.innerText.trim();
    }

    if (typeof node.textContent === "string" && node.textContent.trim().length > 0) {
      return node.textContent.trim();
    }

    return "";
  }

  function isVisibleNode(node) {
    if (!node) {
      return false;
    }

    if (node.getAttribute?.("aria-hidden") === "true") {
      return false;
    }

    if (node.hidden === true) {
      return false;
    }

    return true;
  }

  function isContinueLabel(label) {
    const normalized = (label || "").trim().toLowerCase();
    return (
      normalized === "continue" ||
      normalized === "continue generating" ||
      normalized === "continue response" ||
      normalized === "continue answering" ||
      normalized === "继续" ||
      normalized === "续写" ||
      normalized === "继续生成" ||
      normalized === "继续回答" ||
      normalized === "继续输出"
    );
  }

  function isRetryLabel(label) {
    const normalized = (label || "").trim().toLowerCase();
    return (
      normalized === "retry" ||
      normalized === "try again" ||
      normalized === "retry message" ||
      normalized === "retry response" ||
      normalized === "retry generation" ||
      normalized === "重试" ||
      normalized === "再试一次" ||
      normalized === "重新尝试" ||
      normalized === "重新生成" ||
      normalized === "重新回答"
    );
  }

  function containsStoppedMarker(text) {
    const normalized = (text || "").trim().toLowerCase();
    return (
      normalized.includes("stopped") ||
      normalized.includes("已停止") ||
      normalized.includes("中断")
    );
  }

  function containsServerBusyMarker(text) {
    const normalized = (text || "").trim().toLowerCase();
    return (
      normalized.includes("server is busy") ||
      (normalized.includes("try again later") && normalized.includes("instant mode")) ||
      normalized.includes("服务繁忙") ||
      normalized.includes("服务器繁忙") ||
      normalized.includes("稍后重试") ||
      (normalized.includes("稍后再试") && normalized.includes("instant"))
    );
  }

  function findContinueButton() {
    const clickableNodes = Array.from(
      document.querySelectorAll("button, a, div[role='button']")
    );
    const matches = clickableNodes.filter((node) => {
      if (!isVisibleNode(node) || isClickableNodeDisabled(node)) {
        return false;
      }

      return isContinueLabel(getNodeLabel(node));
    });

    return matches.at(-1) || null;
  }

  function findRetryButton() {
    const clickableNodes = Array.from(
      document.querySelectorAll("button, a, div[role='button']")
    );
    const matches = clickableNodes.filter((node) => {
      if (!isVisibleNode(node) || isClickableNodeDisabled(node)) {
        return false;
      }

      return isRetryLabel(getNodeLabel(node));
    });

    return matches.at(-1) || null;
  }

  function findRecoverableContinueButton() {
    if (findStopButton()) {
      return null;
    }

    const continueButton = findContinueButton();
    if (!(continueButton instanceof HTMLElement)) {
      return null;
    }

    let current = continueButton.parentElement || null;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      if (containsStoppedMarker(getNodeText(current))) {
        return continueButton;
      }
      current = current.parentElement;
    }

    const pageText =
      document.body?.innerText ||
      document.body?.textContent ||
      "";
    if (containsStoppedMarker(pageText)) {
      return continueButton;
    }

    return null;
  }

  function detectRecoverableBusyFailure() {
    const pageText =
      document.body?.innerText ||
      document.body?.textContent ||
      "";
    if (!containsServerBusyMarker(pageText)) {
      return null;
    }

    return {
      retryButton: findRetryButton(),
      message:
        "DeepSeek reported that the server is busy. Retry this turn from the page or recover the turn in the helper runtime.",
    };
  }

  async function maybeAutoContinueInterruptedReply(continueButton) {
    if (!(continueButton instanceof HTMLElement)) {
      return false;
    }

    const now = Date.now();
    if (completionState.continueAttempts >= 2) {
      return false;
    }

    if (now - completionState.lastContinueAt < 1_200) {
      return false;
    }

    completionState.continueAttempts += 1;
    completionState.lastContinueAt = now;
    continueButton.click();
    await sleep(350);
    return true;
  }

  async function maybeAutoRetryFailedSubmission(retryButton) {
    if (!(retryButton instanceof HTMLElement)) {
      return false;
    }

    const now = Date.now();
    if (completionState.retryAttempts >= 2) {
      return false;
    }

    if (now - completionState.lastRetryAt < 1_200) {
      return false;
    }

    completionState.retryAttempts += 1;
    completionState.lastRetryAt = now;
    retryButton.click();
    await sleep(350);
    return true;
  }

  function findNewChatButton() {
    const directMatch =
      document.querySelector("button[aria-label='New Chat']") ||
      document.querySelector("button[aria-label='New chat']") ||
      document.querySelector("button[aria-label='新对话']") ||
      document.querySelector("button[aria-label='新建对话']") ||
      document.querySelector("a[aria-label='New Chat']") ||
      document.querySelector("a[aria-label='新对话']") ||
      document.querySelector("[data-testid='new-chat']");

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

  function getNodeLabel(node) {
    const parts = [];
    const textContent =
      node && typeof node.textContent === "string" ? node.textContent : "";
    if (textContent.length > 0) {
      parts.push(textContent);
    }
    if (typeof node?.getAttribute === "function") {
      const ariaLabel = node.getAttribute("aria-label");
      const title = node.getAttribute("title");
      const dataTestId = node.getAttribute("data-testid");
      if (typeof ariaLabel === "string" && ariaLabel.length > 0) {
        parts.push(ariaLabel);
      }
      if (typeof title === "string" && title.length > 0) {
        parts.push(title);
      }
      if (typeof dataTestId === "string" && dataTestId.length > 0) {
        parts.push(dataTestId);
      }
    }

    return parts.join(" ").trim().toLowerCase();
  }

  function isClickableNodeDisabled(node) {
    if (!node) {
      return true;
    }

    const className = (node.className || "").toString().toLowerCase();
    return (
      node.getAttribute?.("aria-disabled") === "true" ||
      node.getAttribute?.("disabled") === "true" ||
      node.disabled === true ||
      className.includes("disabled")
    );
  }

  function isModeNodeSelected(node) {
    if (!node || typeof node.getAttribute !== "function") {
      return false;
    }

    const className = (node.className || "").toString().toLowerCase();
    return (
      node.getAttribute("aria-checked") === "true" ||
      node.getAttribute("aria-pressed") === "true" ||
      node.getAttribute("aria-selected") === "true" ||
      node.getAttribute("aria-current") === "true" ||
      node.checked === true ||
      node.getAttribute("data-state") === "active" ||
      className.includes("active") ||
      className.includes("selected") ||
      className.includes("current")
    );
  }

  function matchesDeepSeekModeLabel(node, targetModelType) {
    const label = getNodeLabel(node);
    if (label.length === 0) {
      return false;
    }

    if (targetModelType === "expert") {
      return (
        label.includes("expert") ||
        label.includes("专家") ||
        label.includes("pro") ||
        label.includes("deepthink") ||
        label.includes("深度思考")
      );
    }

    return (
      label.includes("flash") ||
      label.includes("instant") ||
      label.includes("default") ||
      label.includes("快速模式") ||
      label.includes("普通模式") ||
      label.includes("标准") ||
      label.includes("默认")
    );
  }

  function isDeepSeekConversationPath(pathname) {
    return ((pathname || "").toLowerCase()).startsWith("/a/chat/s/");
  }

  function getModeControlNodes() {
    return Array.from(
      document.querySelectorAll(
        "button, a, div[role='button'], [role='radio'], input[type='radio']"
      )
    );
  }

  function isRadioModeNode(node) {
    if (!node || typeof node.getAttribute !== "function") {
      return false;
    }

    return node.getAttribute("role") === "radio" || node.tagName === "INPUT";
  }

  function groupSiblingModeNodes(nodes) {
    const groups = [];
    const groupIndexes = new Map();

    for (const node of nodes) {
      const container = node.parentElement || node;
      const existingIndex = groupIndexes.get(container);
      if (typeof existingIndex === "number") {
        groups[existingIndex].push(node);
        continue;
      }

      groupIndexes.set(container, groups.length);
      groups.push([node]);
    }

    return groups;
  }

  function findRadioModeButton(targetModelType) {
    const radioNodes = getModeControlNodes().filter((node) =>
      isRadioModeNode(node) && !isClickableNodeDisabled(node)
    );
    if (radioNodes.length < 2) {
      return null;
    }

    const radioGroups = groupSiblingModeNodes(radioNodes)
      .filter((group) => group.length >= 2);
    if (radioGroups.length === 0) {
      return null;
    }

    const composer = findComposer();
    const preferredGroup =
      radioGroups.find((group) => {
        const container = group[0]?.parentElement;
        return (
          composer &&
          container &&
          typeof container.compareDocumentPosition === "function" &&
          (container.compareDocumentPosition(composer) & 4) === 4
        );
      }) ||
      radioGroups[0] ||
      null;
    if (!preferredGroup) {
      return null;
    }

    return targetModelType === "expert"
      ? preferredGroup[1] || preferredGroup.at(-1) || null
      : preferredGroup[0] || null;
  }

  function findModeButton(targetModelType) {
    const structuralMatch = findRadioModeButton(targetModelType);
    if (structuralMatch) {
      return structuralMatch;
    }

    const candidates = getModeControlNodes().filter((node) =>
      matchesDeepSeekModeLabel(node, targetModelType) &&
      !isClickableNodeDisabled(node)
    );

    if (candidates.length === 0) {
      return null;
    }

    return candidates.find((node) => isModeNodeSelected(node)) || candidates[0] || null;
  }

  function getVisibleModeLabels() {
    const labels = [];
    for (const node of getModeControlNodes()) {
      const label = getNodeLabel(node);
      if (label.length === 0 || labels.includes(label)) {
        continue;
      }
      labels.push(label);
      if (labels.length >= 8) {
        break;
      }
    }

    return labels;
  }

  async function ensureModelType(targetModelType) {
    if (targetModelType !== "expert" && targetModelType !== "default") {
      return { ok: true };
    }

    const timeoutMs = 8_000;
    const pollMs = 100;
    const startedAt = Date.now();
    let sawModeButton = false;

    while (Date.now() - startedAt <= timeoutMs) {
      const modeButton = findModeButton(targetModelType);
      if (!(modeButton instanceof HTMLElement)) {
        await sleep(pollMs);
        continue;
      }

      sawModeButton = true;
      if (isModeNodeSelected(modeButton)) {
        return { ok: true };
      }

      modeButton.click();
      await sleep(250);

      const updatedModeButton = findModeButton(targetModelType);
      if (
        updatedModeButton instanceof HTMLElement &&
        isModeNodeSelected(updatedModeButton)
      ) {
        return { ok: true };
      }

      await sleep(pollMs);
    }

    return {
      ok: false,
      error: "AUTOMATION_DESYNC",
      message: sawModeButton
        ? "DeepSeek " + targetModelType + " mode switch did not stick"
        : "DeepSeek " +
          targetModelType +
          " mode control not found" +
          (() => {
            const labels = getVisibleModeLabels();
            return labels.length > 0
              ? " (visible controls: " + labels.join(" | ") + ")"
              : "";
          })(),
    };
  }

  async function waitForFreshChat(previousUrl) {
    const timeoutMs = 4_000;
    const pollMs = 100;
    const previousPathname = (() => {
      try {
        return new URL(previousUrl, window.location.origin).pathname;
      } catch {
        return "";
      }
    })();
    const shouldRequireRouteChange = isDeepSeekConversationPath(previousPathname);
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const pageState = window[KEY].getPageState();
      if (pageState.blockingMessage) {
        return {
          ok: false,
          error: "PAGE_UNAVAILABLE",
          message: pageState.blockingMessage,
        };
      }

      const currentPathname = (window.location?.pathname || "").toLowerCase();
      const routeChanged =
        !shouldRequireRouteChange || currentPathname !== previousPathname.toLowerCase();

      if (pageState.inputReady && !pageState.busy && routeChanged) {
        return { ok: true };
      }

      await sleep(pollMs);
    }

    return {
      ok: false,
      error: "AUTOMATION_DESYNC",
      message: "DeepSeek new chat did not finish resetting the page",
    };
  }

  function setComposerValue(composer, nextValue) {
    if (composer && composer.tagName !== "TEXTAREA") {
      composer.textContent = nextValue;
      if ("innerText" in composer) {
        composer.innerText = nextValue;
      }
      return;
    }

    const prototype = Object.getPrototypeOf(composer);
    const valueDescriptor =
      prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;

    if (typeof valueDescriptor?.set === "function") {
      valueDescriptor.set.call(composer, nextValue);
      return;
    }

    composer.value = nextValue;
  }

  function normalizeComposerText(value) {
    return String(value || "").replace(/\\r\\n?/g, "\\n").trim();
  }

  function getComposerValue(composer) {
    if (!composer) {
      return "";
    }

    if (composer.tagName === "TEXTAREA") {
      return typeof composer.value === "string" ? composer.value : "";
    }

    if (typeof composer.innerText === "string" && composer.innerText.length > 0) {
      return composer.innerText;
    }

    if (typeof composer.textContent === "string" && composer.textContent.length > 0) {
      return composer.textContent;
    }

    return "";
  }

  function canRetryPromptSubmissionWithKeyboard(prompt) {
    const composer = findComposer();
    if (!composer) {
      return false;
    }

    const currentPrompt = normalizeComposerText(getComposerValue(composer));
    const expectedPrompt = normalizeComposerText(prompt);
    if (expectedPrompt.length === 0 || currentPrompt !== expectedPrompt) {
      return false;
    }

    const sendButton = findSendButton(composer);
    return (
      sendButton instanceof HTMLElement &&
      !isClickableNodeDisabled(sendButton) &&
      !findStopButton()
    );
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
    const baselineAssistantCount = baselineState?.assistantCount || 0;

    while (Date.now() - startedAt < timeoutMs) {
      const pageState = window[KEY].getPageState();

      if (pageState.blockingMessage) {
        return {
          ok: false,
          error: "PAGE_UNAVAILABLE",
          message: "DeepSeek requires manual verification in the browser tab before chatting",
        };
      }

      const recoverableBusyFailure = detectRecoverableBusyFailure();
      if (recoverableBusyFailure) {
        const retried = await maybeAutoRetryFailedSubmission(
          recoverableBusyFailure.retryButton,
        );
        if (retried) {
          continue;
        }

        return {
          ok: false,
          error: "AUTOMATION_DESYNC",
          message: recoverableBusyFailure.message,
        };
      }

      if (
        completionState.observed ||
        completionState.status !== "idle" ||
        pageState.busy ||
        pageState.assistantCount > baselineAssistantCount
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
      const markdownNode = message?.querySelector(".ds-markdown");
      if (markdownNode) {
        return markdownNode;
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

      const recoverableBusyFailure = detectRecoverableBusyFailure();
      if (recoverableBusyFailure) {
        const retried = await maybeAutoRetryFailedSubmission(
          recoverableBusyFailure.retryButton,
        );
        if (retried) {
          continue;
        }

        return {
          ok: false,
          error: "AUTOMATION_DESYNC",
          message: recoverableBusyFailure.message,
        };
      }

      const recoverableContinueButton = findRecoverableContinueButton();
      if (recoverableContinueButton instanceof HTMLElement) {
        const continued = await maybeAutoContinueInterruptedReply(
          recoverableContinueButton,
        );
        if (continued) {
          continue;
        }
      }

      if (
        terminalObserved &&
        streamedTurn &&
        !(recoverableContinueButton instanceof HTMLElement)
      ) {
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
    if (
      streamedReply.length > 0 &&
      !(findRecoverableContinueButton() instanceof HTMLElement)
    ) {
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
      const interactiveComposerReady = hasInteractiveComposer();
      const latestAssistant = latestAssistantNode();
      const shellReady = hasLikelyDeepSeekAppShell();
      const blockingMessage = detectBlockingMessage();
      const virtualListActive = hasRecentVirtualListActivity();
      const domReply = latestAssistant ? (latestAssistant.textContent || "").trim() || null : null;
      const bodyText = (document.body?.innerText || "").trim();
      return {
        inputReady: Boolean(!blockingMessage && (interactiveComposerReady || shellReady)),
        busy:
          Boolean(findStopButton()) ||
          completionState.status === "streaming" ||
          virtualListActive,
        latestAssistantPreview: domReply,
        assistantCount:
          completionState.observed &&
          (completionState.streamReply.trim().length > 0 ||
            completionState.responseMessageId !== null)
            ? Math.max(assistantMessageCount(), 1)
            : assistantMessageCount(),
        activityAt:
          Math.max(completionState.lastEventAt || 0, virtualListState.lastChangedAt || 0) || null,
        shellReady,
        blockingMessage,
        diagnostics: {
          readyState:
            typeof document.readyState === "string" ? document.readyState : "unknown",
          title: typeof document.title === "string" ? document.title : "",
          locationHref:
            typeof window.location?.href === "string" ? window.location.href : "",
          locationPath:
            typeof window.location?.pathname === "string" ? window.location.pathname : "",
          bodyTextLength: bodyText.length,
          composerFound: Boolean(composer),
          interactiveComposerReady,
          newChatButtonFound: Boolean(findNewChatButton()),
          modeControlLabels: getVisibleModeLabels(),
        },
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
          startObserved: true,
          submissionMethod: primarySubmission.method,
        };
      }

      if (primarySubmission.method === "keyboard") {
        return {
          ok: true,
          baselineState,
          startObserved: false,
          submissionMethod: primarySubmission.method,
        };
      }

      if (!canRetryPromptSubmissionWithKeyboard(prompt)) {
        return {
          ok: true,
          baselineState,
          startObserved: false,
          submissionMethod: primarySubmission.method,
        };
      }

      const fallbackSubmission = dispatchPromptSubmission({ prompt, method: "keyboard" });
      if (!fallbackSubmission.ok) {
        return {
          ok: true,
          baselineState,
          startObserved: false,
          submissionMethod: primarySubmission.method,
        };
      }

      const fallbackStart = await waitForSubmissionStart({
        baselineState,
        timeoutMs: SUBMISSION_START_TIMEOUT_MS,
      });
      if (fallbackStart.ok) {
        return {
          ok: true,
          baselineState,
          startObserved: true,
          submissionMethod: fallbackSubmission.method,
        };
      }

      return {
        ok: true,
        baselineState,
        startObserved: false,
        submissionMethod: fallbackSubmission.method,
      };
    },
    openFreshChat() {
      const previousUrl = window.location?.href || "";
      const currentPathname = (window.location?.pathname || "").toLowerCase();
      const newChatButton = findNewChatButton();

      if (newChatButton instanceof HTMLElement) {
        newChatButton.click();
        return {
          ok: true,
          previousUrl,
          action: "click_new_chat",
        };
      }

      if (isDeepSeekConversationPath(currentPathname)) {
        window.location.href = "https://chat.deepseek.com/";
        return {
          ok: true,
          previousUrl,
          action: "navigate_home",
        };
      }

      return {
        ok: true,
        previousUrl,
        action: "reuse_home",
      };
    },
    async startNewChat(input = {}) {
      const opened = window[KEY].openFreshChat();
      const previousUrl =
        opened && typeof opened === "object" && typeof opened.previousUrl === "string"
          ? opened.previousUrl
          : window.location?.href || "";

      const readyResult = await waitForFreshChat(previousUrl);
      if (!readyResult.ok) {
        return readyResult;
      }

      resetCompletionState();
      const modeResult = await ensureModelType(input.targetModelType);
      if (!modeResult.ok) {
        return modeResult;
      }
      return { ok: true };
    },
    async setModelType(input = {}) {
      return ensureModelType(input.targetModelType);
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

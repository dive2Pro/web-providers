import { HelperError } from "../../errors";

export const QWEN_HOST_ALLOWLIST = new Set(["chat.qwen.ai"]);
const QWEN_COMPLETION_PATH = "/api/v2/chat/completions";
export const QWEN_BRIDGE_VERSION = 6;

export function assertQwenUrl(rawUrl: string) {
  const url = new URL(rawUrl);

  if (!QWEN_HOST_ALLOWLIST.has(url.host)) {
    throw new HelperError(
      "PAGE_UNAVAILABLE",
      `Unsupported Qwen host: ${url.host}`,
    );
  }

  return url.toString();
}

function normalizeQwenToolCall(delta: Record<string, unknown>) {
  const candidates = [
    delta.tool_calls,
    delta.toolCalls,
    delta.function_call,
    delta.functionCall,
  ];

  for (const candidate of candidates) {
    const entries = Array.isArray(candidate) ? candidate : [candidate];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const functionCandidate =
        "function" in entry &&
        entry.function &&
        typeof entry.function === "object" &&
        !Array.isArray(entry.function)
          ? (entry.function as Record<string, unknown>)
          : (entry as Record<string, unknown>);

      const name =
        typeof functionCandidate.name === "string"
          ? functionCandidate.name.trim()
          : "";
      const rawArguments =
        "arguments" in functionCandidate ? functionCandidate.arguments : undefined;

      if (!name) {
        continue;
      }

      if (typeof rawArguments === "string") {
        return {
          name,
          argumentsJson: rawArguments,
        };
      }

      if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
        return {
          name,
          argumentsJson: JSON.stringify(rawArguments),
        };
      }
    }
  }

  return null;
}

function parseQwenDeltaText(content: unknown, depth = 0): string {
  if (depth > 4 || content == null) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => parseQwenDeltaText(entry, depth + 1))
      .join("");
  }

  if (typeof content !== "object") {
    return "";
  }

  const candidate = content as Record<string, unknown>;
  const directKeys = ["text", "content", "answer", "value"];

  for (const key of directKeys) {
    if (key in candidate) {
      const extracted = parseQwenDeltaText(candidate[key], depth + 1);
      if (extracted.length > 0) {
        return extracted;
      }
    }
  }

  const nestedKeys = ["message", "delta", "data", "parts", "items", "chunks"];
  for (const key of nestedKeys) {
    if (key in candidate) {
      const extracted = parseQwenDeltaText(candidate[key], depth + 1);
      if (extracted.length > 0) {
        return extracted;
      }
    }
  }

  return "";
}

function parseQwenCompletionSseState(body: string) {
  let thinkingText = "";
  let outputText = "";
  let toolCall: { name: string; argumentsJson: string } | null = null;
  let finished = false;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      continue;
    }

    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    if ("response.completed" in parsed) {
      finished = true;
    }

    const choices = Array.isArray((parsed as { choices?: unknown }).choices)
      ? ((parsed as { choices: Array<{ delta?: Record<string, unknown> }> }).choices)
      : [];

    for (const choice of choices) {
      const delta =
        choice && typeof choice === "object" && choice.delta && typeof choice.delta === "object"
          ? choice.delta
          : null;

      if (!delta) {
        continue;
      }

      const phase = typeof delta.phase === "string" ? delta.phase : null;
      const content = parseQwenDeltaText(
        "content" in delta
          ? delta.content
          : "message" in delta
            ? delta.message
            : "answer" in delta
              ? delta.answer
              : delta,
      );
      const nextToolCall = normalizeQwenToolCall(delta);
      const status = typeof delta.status === "string" ? delta.status : null;

      if (nextToolCall) {
        toolCall = nextToolCall;
      }

      if (status === "finished") {
        finished = true;
      }

      if ((phase === "answer" || phase === null) && content.length > 0) {
        outputText += content;
      }

      if (phase === "thinking_summary") {
        const extra =
          delta.extra && typeof delta.extra === "object" && !Array.isArray(delta.extra)
            ? (delta.extra as Record<string, unknown>)
            : null;
        const summaryTitle =
          extra &&
          extra.summary_title &&
          typeof extra.summary_title === "object" &&
          !Array.isArray(extra.summary_title) &&
          Array.isArray((extra.summary_title as { content?: unknown }).content)
            ? ((extra.summary_title as { content: unknown[] }).content)
                .filter((entry): entry is string => typeof entry === "string")
                .join("")
            : "";

        const summaryThought =
          extra &&
          extra.summary_thought &&
          typeof extra.summary_thought === "object" &&
          !Array.isArray(extra.summary_thought) &&
          Array.isArray((extra.summary_thought as { content?: unknown }).content)
            ? ((extra.summary_thought as { content: unknown[] }).content)
                .filter((entry): entry is string => typeof entry === "string")
                .join("")
            : "";

        const nextThinking = [summaryTitle.trim(), summaryThought.trim()]
          .filter((part) => part.length > 0)
          .join("\n\n");

        if (nextThinking.length > 0) {
          thinkingText = nextThinking;
        }
      }
    }
  }

  if (toolCall) {
    return {
      mode: "native_tool_call" as const,
      finished,
      ...(thinkingText.length > 0 ? { thinkingText } : {}),
      toolCall,
      outputText: outputText.trim(),
    };
  }

  return {
    mode: "text" as const,
    finished,
    ...(thinkingText.length > 0 ? { thinkingText } : {}),
    outputText: outputText.trim(),
  };
}

export function parseQwenCompletionSse(body: string) {
  const { finished: _finished, ...parsed } = parseQwenCompletionSseState(body);
  return parsed;
}

function createQwenBridge() {
  const normalizeToolCall = normalizeQwenToolCall.toString();
  const parseDeltaText = parseQwenDeltaText.toString();
  const parseState = parseQwenCompletionSseState.toString();
  const parseSse = parseQwenCompletionSse.toString();

  return `(() => {
    ${normalizeToolCall}
    ${parseDeltaText}
    ${parseState}
    ${parseSse}
    const COMPLETION_PATH = ${JSON.stringify(QWEN_COMPLETION_PATH)};
    const BRIDGE_VERSION = ${JSON.stringify(QWEN_BRIDGE_VERSION)};

    function createCompletionState() {
      return {
        version: BRIDGE_VERSION,
        observed: false,
        status: "idle",
        closed: false,
        thinking: "",
        streamReply: "",
        toolCall: null,
        bodyPreview: "",
        bodyTailPreview: "",
        parserSummary: "",
        lastError: "",
        lastEventAt: 0,
        terminalAt: 0,
      };
    }

    function ensureState() {
      if (
        !window.__piQwenBridgeState ||
        window.__piQwenBridgeState.version !== BRIDGE_VERSION
      ) {
        window.__piQwenBridgeState = createCompletionState();
      }

      return window.__piQwenBridgeState;
    }

    function resetCompletionState() {
      window.__piQwenBridgeState = createCompletionState();
      return window.__piQwenBridgeState;
    }

    function findComposer() {
      return document.querySelector("textarea.message-input-textarea") ?? document.querySelector("textarea");
    }

    function findLatestAssistantAnswer() {
      const answers = Array.from(document.querySelectorAll(".response-message-content.t2t.phase-answer, .custom-qwen-markdown, .qwen-chat-message-assistant .qwen-markdown-text"));
      for (let index = answers.length - 1; index >= 0; index -= 1) {
        const text = (answers[index]?.textContent || "").trim();
        if (text.length > 0) {
          return text;
        }
      }

      return "";
    }

    function countAssistantMessages() {
      return document.querySelectorAll(".qwen-chat-message-assistant").length;
    }

    function detectBlockingMessage() {
      const path = location.pathname.toLowerCase();
      const pageText = (document.body?.innerText || "").trim();
      const normalizedText = pageText.toLowerCase();
      const signInIndicators = [
        "Sign in",
        "Log in",
        "Continue with Google",
        "Continue with Apple",
        "Scan to log in",
      ];
      const authPath =
        path.includes("login") ||
        path.includes("signin") ||
        path.includes("sign-in") ||
        path.includes("auth");
      const signInPrompt = signInIndicators.some((indicator) =>
        normalizedText.includes(indicator.toLowerCase()),
      );

      if (authPath || signInPrompt) {
        return "Please sign in to Qwen in the browser tab.";
      }

      return null;
    }

    function getPageState() {
      const composer = findComposer();
      const latestAssistantPreview = findLatestAssistantAnswer();
      const completionState = ensureState();
      const blockingMessage = detectBlockingMessage();

      return {
        inputReady: Boolean(!blockingMessage && composer && !composer.disabled),
        busy: completionState.status === "streaming",
        latestAssistantPreview: latestAssistantPreview || null,
        assistantCount: countAssistantMessages(),
        blockingMessage,
      };
    }

    function getCompletionState() {
      const state = ensureState();
      const reply = (state.streamReply || "").trim();
      const thinking = (state.thinking || "").trim();
      const toolCall = state.toolCall;

      return {
        observed: state.observed,
        status: state.status,
        closed: state.closed,
        terminalAt: state.terminalAt || null,
        bodyPreview: state.bodyPreview || null,
        bodyTailPreview: state.bodyTailPreview || null,
        parserSummary: state.parserSummary || null,
        lastError: state.lastError || null,
        turn: toolCall
          ? {
              mode: "native_tool_call",
              toolCall,
              ...(reply.length > 0 ? { outputText: reply } : {}),
              ...(thinking.length > 0 ? { thinkingText: thinking } : {}),
            }
          : reply.length > 0
          ? {
              mode: "text",
              outputText: reply,
              ...(thinking.length > 0 ? { thinkingText: thinking } : {}),
            }
          : null,
      };
    }

    function ensureFetchPatched() {
      if (window.__piQwenFetchPatchedVersion === BRIDGE_VERSION) {
        return;
      }

      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const url = String(args[0] && (args[0].url || args[0]));
        const response = await originalFetch(...args);

        if (!url.includes(COMPLETION_PATH)) {
          return response;
        }

        const state = resetCompletionState();
        state.observed = true;
        state.status = "streaming";
        state.lastEventAt = Date.now();
        state.lastError = "";

        const clone = response.clone();
        clone.text().then((body) => {
          const parsed = parseQwenCompletionSseState(body);
          state.bodyPreview = body.trim().slice(0, 1200);
          state.bodyTailPreview = body.trim().slice(-1200);
          state.parserSummary = JSON.stringify({
            mode: parsed.mode,
            finished: parsed.finished,
            hasThinking: Boolean(parsed.thinkingText),
            hasOutputText: Boolean(parsed.outputText),
            hasToolCall: Boolean(parsed.mode !== "text" && parsed.toolCall),
          });
          state.thinking = parsed.thinkingText || "";
          state.streamReply = parsed.outputText || "";
          state.toolCall = parsed.mode !== "text" ? parsed.toolCall : null;
          state.status =
            parsed.finished || state.streamReply.trim().length > 0 || state.toolCall
              ? "finished"
              : "idle";
          state.closed = true;
          state.terminalAt = Date.now();
          state.lastEventAt = state.terminalAt;
        }).catch((error) => {
          state.lastError = String(error);
          state.status = "idle";
          state.closed = true;
          state.terminalAt = Date.now();
          state.lastEventAt = state.terminalAt;
        });

        return response;
      };

      window.__piQwenFetchPatched = true;
      window.__piQwenFetchPatchedVersion = BRIDGE_VERSION;
    }

    function startNewChat() {
      const trigger = Array.from(document.querySelectorAll("button,div,a")).find((node) => {
        const text = (node.textContent || "").trim();
        return text === "New Chat";
      });

      if (!trigger) {
        throw new Error("Qwen new chat trigger not found");
      }

      trigger.click();
      resetCompletionState();
      return true;
    }

    ensureFetchPatched();
    ensureState();

    window.__piQwenBridge = {
      getPageState,
      getCompletionState,
      startNewChat,
      resetCompletionState,
      ensureFetchPatched,
    };
  })()`;
}

export const INJECTED_QWEN_BRIDGE_SOURCE = createQwenBridge();
export const QWEN_BIND_SCRIPT =
  `${INJECTED_QWEN_BRIDGE_SOURCE}; window.__piQwenBridge.getPageState()`;
export const QWEN_PAGE_STATE_SCRIPT =
  `${INJECTED_QWEN_BRIDGE_SOURCE}; window.__piQwenBridge.getPageState()`;
export const QWEN_PROGRESS_SCRIPT =
  `${INJECTED_QWEN_BRIDGE_SOURCE}; ({ pageState: window.__piQwenBridge.getPageState(), completionState: window.__piQwenBridge.getCompletionState() })`;
export const QWEN_RESET_COMPLETION_SCRIPT =
  `${INJECTED_QWEN_BRIDGE_SOURCE}; window.__piQwenBridge.resetCompletionState()`;
export const QWEN_START_NEW_CHAT_SCRIPT =
  `${INJECTED_QWEN_BRIDGE_SOURCE}; window.__piQwenBridge.startNewChat()`;

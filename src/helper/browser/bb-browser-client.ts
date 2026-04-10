import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HelperError } from "../errors";
import type {
  BrowserAutomationClient,
  BindResult,
  PageStateSummary,
  SendChatAutomationDebug,
  SendChatResult,
} from "./types";
import { assertDeepSeekUrl, INJECTED_BRIDGE_SOURCE } from "./deepseek-page-bridge";
import { createProviderRegistry } from "../providers/registry";
import {
  INJECTED_QWEN_BRIDGE_SOURCE,
  QWEN_PAGE_STATE_SCRIPT,
  QWEN_PROGRESS_SCRIPT,
  QWEN_RESET_COMPLETION_SCRIPT,
  QWEN_START_NEW_CHAT_SCRIPT,
} from "../providers/qwen/page-bridge";

const execFileAsync = promisify(execFile);

interface BbBrowserEnvelope<T> {
  success?: boolean;
  error?: string;
  data?: T;
}

interface BbBrowserEvalEnvelope<T> {
  result?: T;
}

interface BbBrowserTabListEnvelope {
  tabs?: Array<{
    index?: number;
    tabId?: string;
    url?: string;
  }>;
}

export interface BbBrowserTransport {
  getConnectionStatus(): Promise<"connected" | "disconnected">;
  findDeepSeekTab(): Promise<{ id: string; url: string }>;
  findQwenTab?(): Promise<{ id: string; url: string }>;
  openDeepSeek(url: string): Promise<void>;
  openQwen?(url: string): Promise<void>;
  evaluate<T>(tabId: string, script: string): Promise<T>;
  submitPrompt(tabId: string, prompt: string): Promise<void>;
}

function unwrapEnvelope<T>(value: unknown): T {
  if (
    value &&
    typeof value === "object" &&
    ("success" in value || "error" in value || "data" in value)
  ) {
    const envelope = value as BbBrowserEnvelope<T>;

    if (envelope.success === false) {
      throw new Error(envelope.error ?? "bb-browser command failed");
    }

    if ("data" in envelope) {
      return envelope.data as T;
    }
  }

  return value as T;
}

export function extractTabsFromTabList(
  raw: unknown,
): Array<{ index: number; id: string; url: string }> {
  const unwrapped = unwrapEnvelope<
    BbBrowserTabListEnvelope | Array<{ index?: number; id?: string; url?: string }>
  >(raw);

  if (Array.isArray(unwrapped)) {
    return unwrapped.flatMap((tab) =>
      typeof tab.index === "number" &&
      typeof tab.id === "string" &&
      typeof tab.url === "string"
        ? [{ index: tab.index, id: tab.id, url: tab.url }]
        : [],
    );
  }

  if (unwrapped && typeof unwrapped === "object" && Array.isArray(unwrapped.tabs)) {
    return unwrapped.tabs.flatMap((tab) =>
      typeof tab.index === "number" &&
      typeof tab.tabId === "string" &&
      typeof tab.url === "string"
        ? [{ index: tab.index, id: tab.tabId, url: tab.url }]
        : [],
    );
  }

  return [];
}

export function unwrapEvalResult<T>(raw: unknown): T {
  const unwrapped = unwrapEnvelope<BbBrowserEvalEnvelope<T>>(raw);

  if (
    unwrapped &&
    typeof unwrapped === "object" &&
    "result" in unwrapped
  ) {
    return (unwrapped as BbBrowserEvalEnvelope<T>).result as T;
  }

  return unwrapped as T;
}

async function runBbBrowserJson(args: string[]) {
  const { stdout } = await execFileAsync("bb-browser", [...args, "--json"], {
    maxBuffer: 20 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const preview = stdout.slice(0, 300).replace(/\s+/g, " ");
    throw new Error(
      `Failed to parse bb-browser JSON for "${args.join(" ")}": ${message}. stdout preview: ${preview}`,
    );
  }
}

export function createBbBrowserTransport(): BbBrowserTransport {
  async function listTabs() {
    const raw = await runBbBrowserJson(["tab", "list"]);
    return extractTabsFromTabList(raw);
  }

  async function selectTabById(tabId: string) {
    const tabs = await listTabs();
    const selected = tabs.find((tab) => tab.id === tabId);

    if (!selected) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    await runBbBrowserJson(["tab", String(selected.index)]);
  }

  return {
    async getConnectionStatus() {
      try {
        const result = (await runBbBrowserJson(["status"])) as { running?: boolean };
        return result.running ? "connected" : "disconnected";
      } catch {
        return "disconnected";
      }
    },

    async findDeepSeekTab() {
      const list = await listTabs();
      const tab = list.find((entry) => entry.url.includes("deepseek.com"));

      if (!tab) {
        throw new HelperError("NOT_BOUND", "No logged-in DeepSeek tab is available");
      }

      return tab;
    },

    async findQwenTab() {
      const list = await listTabs();
      const tab = list.find((entry) => entry.url.includes("chat.qwen.ai"));

      if (!tab) {
        throw new HelperError("NOT_BOUND", "No logged-in Qwen tab is available");
      }

      return tab;
    },

    async evaluate<T>(tabId: string, script: string): Promise<T> {
      await selectTabById(tabId);
      const raw = await runBbBrowserJson(["eval", script]);
      return unwrapEvalResult<T>(raw);
    },

    async submitPrompt(tabId: string, prompt: string) {
      await selectTabById(tabId);

      const { stdout: snapshotText } = await execFileAsync(
        "bb-browser",
        ["snapshot", "-i", "-s", "textarea"],
        {
          maxBuffer: 20 * 1024 * 1024,
        },
      );

      const namedTextboxRef = snapshotText.match(
        /textbox \[ref=(\d+)\] "Message DeepSeek"/i,
      )?.[1];
      const textboxMatches = Array.from(snapshotText.matchAll(/textbox \[ref=(\d+)\]/g));
      const fallbackTextboxRef = textboxMatches.at(-1)?.[1];
      const textboxRef = namedTextboxRef ?? fallbackTextboxRef;

      if (!textboxRef) {
        throw new Error("DeepSeek composer textbox not found in snapshot");
      }

      await execFileAsync("bb-browser", ["fill", textboxRef, prompt], {
        maxBuffer: 20 * 1024 * 1024,
      });
      await execFileAsync("bb-browser", ["press", "Enter"], {
        maxBuffer: 20 * 1024 * 1024,
      });
    },

    async openDeepSeek(url: string) {
      await runBbBrowserJson(["open", url]);
    },

    async openQwen(url: string) {
      await runBbBrowserJson(["open", url]);
    },
  };
}

function isBrowserAutomationDebugEnabled() {
  return process.env.PI_DEEPSEEK_DEBUG === "1";
}

function previewDebugText(text: string | null | undefined, maxLength = 120) {
  if (typeof text !== "string") {
    return text ?? null;
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

function pushAutomationTrace(
  trace: NonNullable<SendChatAutomationDebug["trace"]> | null,
  entry: NonNullable<SendChatAutomationDebug["trace"]>[number],
) {
  if (!trace) {
    return;
  }

  trace.push(entry);
  if (trace.length > 12) {
    trace.splice(0, trace.length - 12);
  }
}

function buildAutomationDebug(input: {
  source: SendChatAutomationDebug["source"];
  freshSession: boolean;
  completionObserved?: boolean;
  baselineReply?: string;
  latestReply?: string;
  finalReply?: string;
  startMode?: SendChatAutomationDebug["startMode"];
  trace?: SendChatAutomationDebug["trace"] | null;
}): SendChatAutomationDebug {
  const debugEnabled = isBrowserAutomationDebugEnabled();
  return {
    source: input.source,
    freshSession: input.freshSession,
    ...(debugEnabled && typeof input.completionObserved === "boolean"
      ? { completionObserved: input.completionObserved }
      : {}),
    ...(typeof input.baselineReply === "string" ? { baselineReply: input.baselineReply } : {}),
    ...(typeof input.latestReply === "string" ? { latestReply: input.latestReply } : {}),
    ...(typeof input.finalReply === "string" ? { finalReply: input.finalReply } : {}),
    ...(debugEnabled && input.startMode
      ? { startMode: input.startMode }
      : {}),
    ...(input.trace && input.trace.length > 0
      ? { trace: input.trace }
      : {}),
  };
}

function looksLikeIncompleteStructuredText(text: string | null | undefined) {
  if (typeof text !== "string") {
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}

export class BbBrowserClient implements BrowserAutomationClient {
  private readonly providerRegistry: ReturnType<typeof createProviderRegistry>;

  constructor(private readonly transport: BbBrowserTransport) {
    this.providerRegistry = createProviderRegistry(transport);
  }

  async getConnectionStatus() {
    return this.transport.getConnectionStatus();
  }

  async bindDeepSeekTab(): Promise<BindResult> {
    return this.providerRegistry["deepseek-web"].bindTab();
  }

  async bindProviderTab(input: { provider: "deepseek-web" | "qwen-web" }): Promise<BindResult> {
    return this.providerRegistry[input.provider].bindTab();
  }

  async resetPageBridge(tabId: string): Promise<void> {
    await this.transport.evaluate<boolean>(
      tabId,
      "(() => { try { delete window.__piDeepSeekBridge; } catch {} try { delete window.__piQwenBridge; } catch {} window.__piDeepSeekBridge = undefined; window.__piQwenBridge = undefined; return true; })()",
    );
  }

  async startNewChat(
    input:
      | string
      | {
          provider: "deepseek-web" | "qwen-web";
          tabId: string;
        },
  ): Promise<void> {
    if (typeof input !== "string" && input.provider === "qwen-web") {
      await this.transport.evaluate(input.tabId, QWEN_START_NEW_CHAT_SCRIPT);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await this.transport.evaluate(input.tabId, INJECTED_QWEN_BRIDGE_SOURCE);
      return;
    }

    const tabId = typeof input === "string" ? input : input.tabId;
    try {
      await this.transport.evaluate(
        tabId,
        `${INJECTED_BRIDGE_SOURCE}; window.__piDeepSeekBridge.startNewChat()`,
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isExpectedNavigation =
        message.includes("Inspected target navigated or closed") ||
        message.includes("Execution context was destroyed");

      if (!isExpectedNavigation) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await this.transport.evaluate(tabId, INJECTED_BRIDGE_SOURCE);
  }

  async sendChatPrompt(input: {
    provider?: "deepseek-web" | "qwen-web";
    tabId: string;
    prompt: string;
    timeoutMs: number;
    freshSession?: boolean;
  }): Promise<SendChatResult> {
    if (input.provider === "qwen-web") {
      return this.sendQwenChatPrompt(input);
    }

    const STREAM_TEXT_DOM_GRACE_MS = 750;
    const promptLiteral = JSON.stringify(input.prompt);
    const startPromptScript =
      `${INJECTED_BRIDGE_SOURCE}; window.__piDeepSeekBridge.startPrompt({ prompt: ${promptLiteral} })`;
    const pageStateScript = `${INJECTED_BRIDGE_SOURCE}; window.__piDeepSeekBridge.getPageState()`;
    const progressScript =
      `${INJECTED_BRIDGE_SOURCE}; ({ pageState: window.__piDeepSeekBridge.getPageState(), completionState: window.__piDeepSeekBridge.getCompletionState() })`;
    const trace: NonNullable<SendChatAutomationDebug["trace"]> = [];
    let baselineReply: string | undefined;
    let latestReply: string | undefined;
    let finalReply: string | undefined;
    let completionObserved = false;
    let startMode: SendChatAutomationDebug["startMode"] | undefined;
    let shouldFallbackToTransportSubmit = false;
    const buildFailure = (
      code: HelperError["code"],
      message: string,
    ) =>
      new HelperError(
        code,
        message,
        buildAutomationDebug({
          source: "client_error",
          freshSession: input.freshSession === true,
          baselineReply,
          latestReply,
          finalReply,
          completionObserved,
          startMode,
          trace,
        }),
      );

    try {
      const startResult = await this.transport.evaluate<{
        ok?: boolean;
        baselineState?: {
          inputReady?: boolean;
          busy?: boolean;
          latestAssistantPreview?: string | null;
          assistantCount?: number;
          blockingMessage?: string | null;
        };
        error?: string;
        message?: string;
      }>(input.tabId, startPromptScript);

      if (startResult && typeof startResult === "object" && "ok" in startResult) {
        if (startResult.error === "PAGE_UNAVAILABLE") {
          throw buildFailure(
            "PAGE_UNAVAILABLE",
            startResult.message ??
              "DeepSeek requires manual verification in the browser tab before chatting",
          );
        }

        if (startResult.error === "TIMEOUT") {
          throw buildFailure(
            "TIMEOUT",
            startResult.message ?? "The page did not finish streaming in time",
          );
        }

        if (startResult.error) {
          shouldFallbackToTransportSubmit = startResult.error === "AUTOMATION_DESYNC";
          if (!shouldFallbackToTransportSubmit) {
            throw buildFailure(
              "AUTOMATION_DESYNC",
              startResult.message ?? startResult.error,
            );
          }
        }
      }

      const baselineState = startResult && typeof startResult === "object" && startResult.baselineState
        ? {
            inputReady: startResult.baselineState.inputReady ?? true,
            busy: startResult.baselineState.busy ?? false,
            latestAssistantPreview: startResult.baselineState.latestAssistantPreview ?? null,
            assistantCount: startResult.baselineState.assistantCount ?? 0,
            blockingMessage: startResult.baselineState.blockingMessage ?? null,
          }
        : await this.transport.evaluate<{
            inputReady: boolean;
            busy: boolean;
            latestAssistantPreview: string | null;
            assistantCount: number;
            blockingMessage?: string | null;
          }>(input.tabId, pageStateScript);

      if (baselineState.blockingMessage) {
        throw buildFailure(
          "PAGE_UNAVAILABLE",
          "DeepSeek requires manual verification in the browser tab before chatting",
        );
      }

      startMode =
        startResult && typeof startResult === "object" && startResult.ok && !shouldFallbackToTransportSubmit
          ? "bridge_start"
          : "transport_submit";

      pushAutomationTrace(trace, {
        phase: "start_prompt",
        note:
          shouldFallbackToTransportSubmit && startResult && typeof startResult === "object"
            ? `bridge_start_failed:${startResult.message ?? startResult.error ?? "AUTOMATION_DESYNC"}`
            : startMode,
        pageBusy: baselineState.busy,
        pageReplyPreview: previewDebugText(baselineState.latestAssistantPreview),
        assistantCount: baselineState.assistantCount,
      });

      if (startMode === "transport_submit") {
        await this.transport.submitPrompt(input.tabId, input.prompt);
      }

      baselineReply = (baselineState.latestAssistantPreview ?? "").trim();
      const baselineAssistantCount = baselineState.assistantCount;
      const startedAt = Date.now();
      const idleTimeoutMs = input.timeoutMs;
      const hardTimeoutMs = Math.max(input.timeoutMs * 4, 120_000);
      let lastProgressAt = startedAt;
      let previousReply = baselineReply;
      let previousAssistantCount = baselineAssistantCount;

      while (Date.now() - startedAt < hardTimeoutMs) {
        const progress = await this.transport.evaluate<{
          pageState: {
            inputReady: boolean;
            busy: boolean;
            latestAssistantPreview: string | null;
            assistantCount: number;
            blockingMessage?: string | null;
          };
          completionState: {
            observed?: boolean;
            status?: string;
            closed?: boolean;
            terminalAt?: number | null;
            turn?: SendChatResult | null;
          };
        }>(input.tabId, progressScript);
        const state =
          progress &&
          typeof progress === "object" &&
          "pageState" in progress &&
          progress.pageState
            ? progress.pageState
            : progress &&
                typeof progress === "object" &&
                "inputReady" in progress &&
                "busy" in progress &&
                "latestAssistantPreview" in progress &&
                "assistantCount" in progress
              ? {
                  inputReady: Boolean(progress.inputReady),
                  busy: Boolean(progress.busy),
                  latestAssistantPreview:
                    typeof progress.latestAssistantPreview === "string" ||
                    progress.latestAssistantPreview === null
                      ? progress.latestAssistantPreview
                      : null,
                  assistantCount:
                    typeof progress.assistantCount === "number" ? progress.assistantCount : 0,
                  blockingMessage:
                    "blockingMessage" in progress &&
                    (typeof progress.blockingMessage === "string" ||
                      progress.blockingMessage === null)
                      ? progress.blockingMessage
                      : null,
                }
              : await this.transport.evaluate<{
                  inputReady: boolean;
                  busy: boolean;
                  latestAssistantPreview: string | null;
                  assistantCount: number;
                  blockingMessage?: string | null;
                }>(input.tabId, pageStateScript);
        const completionState =
          progress &&
          typeof progress === "object" &&
          "completionState" in progress
            ? progress.completionState
            : null;
        completionObserved = completionObserved || completionState?.observed === true;

        pushAutomationTrace(trace, {
          phase: "poll",
          pageBusy: state.busy,
          pageReplyPreview: previewDebugText(state.latestAssistantPreview),
          assistantCount: state.assistantCount,
          completionStatus:
            completionState && typeof completionState.status === "string"
              ? completionState.status
              : null,
          completionClosed:
            completionState && typeof completionState.closed === "boolean"
              ? completionState.closed
              : false,
          completionObserved:
            completionState && typeof completionState.observed === "boolean"
              ? completionState.observed
              : false,
          completionTurnMode:
            completionState?.turn && typeof completionState.turn.mode === "string"
              ? completionState.turn.mode
              : null,
          completionTurnPreview:
            completionState?.turn?.mode === "text"
              ? previewDebugText(completionState.turn.outputText)
              : completionState?.turn?.outputText
                ? previewDebugText(completionState.turn.outputText)
                : null,
        });

        if (state.blockingMessage) {
          throw buildFailure(
            "PAGE_UNAVAILABLE",
            "DeepSeek requires manual verification in the browser tab before chatting",
          );
        }

        const streamedTurn = completionState?.turn;
        const terminalObserved =
          completionState?.status === "finished" || completionState?.closed === true;

        if (
          terminalObserved &&
          streamedTurn &&
          streamedTurn.mode !== "text"
        ) {
          pushAutomationTrace(trace, {
            phase: "bridge_stream_tool",
            completionStatus:
              completionState && typeof completionState.status === "string"
                ? completionState.status
                : null,
            completionClosed:
              completionState && typeof completionState.closed === "boolean"
                ? completionState.closed
                : false,
            completionObserved,
            completionTurnMode: streamedTurn.mode,
            completionTurnPreview: previewDebugText(streamedTurn.outputText),
          });
          return {
            ...streamedTurn,
            debug: buildAutomationDebug({
              source: "bridge_stream",
              freshSession: input.freshSession === true,
              completionObserved,
              startMode,
              trace,
            }),
            modelLabel: "DeepSeek Web",
          };
        }

        const nextReply = (state.latestAssistantPreview ?? "").trim();
        const assistantCountIncreased = state.assistantCount > previousAssistantCount;
        const replyChanged = nextReply !== previousReply;
        const hasProgress = assistantCountIncreased || replyChanged || state.busy;
        if (hasProgress) {
          lastProgressAt = Date.now();
          previousAssistantCount = state.assistantCount;
          previousReply = nextReply;
        }

        if (
          terminalObserved &&
          streamedTurn?.mode === "text" &&
          typeof streamedTurn.outputText === "string"
        ) {
          pushAutomationTrace(trace, {
            phase: "bridge_stream_text",
            pageBusy: state.busy,
            pageReplyPreview: previewDebugText(state.latestAssistantPreview),
            assistantCount: state.assistantCount,
            completionStatus:
              completionState && typeof completionState.status === "string"
                ? completionState.status
                : null,
            completionClosed:
              completionState && typeof completionState.closed === "boolean"
                ? completionState.closed
                : false,
            completionObserved,
            completionTurnMode: streamedTurn.mode,
            completionTurnPreview: previewDebugText(streamedTurn.outputText),
          });
          return {
            mode: "text",
            ...(typeof streamedTurn.thinkingText === "string"
              ? { thinkingText: streamedTurn.thinkingText }
              : {}),
            outputText: streamedTurn.outputText,
            debug: buildAutomationDebug({
              source: "bridge_stream",
              freshSession: input.freshSession === true,
              completionObserved,
              startMode,
              trace,
            }),
            modelLabel: "DeepSeek Web",
          };
        }

        if (Date.now() - lastProgressAt >= idleTimeoutMs) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      await this.resetPageBridge(input.tabId);
      const finalState = await this.transport.evaluate<{
        inputReady: boolean;
        busy: boolean;
        latestAssistantPreview: string | null;
        assistantCount: number;
        blockingMessage?: string | null;
      }>(input.tabId, pageStateScript);

      if (finalState.blockingMessage) {
        throw buildFailure(
          "PAGE_UNAVAILABLE",
          "DeepSeek requires manual verification in the browser tab before chatting",
        );
      }

      throw buildFailure("TIMEOUT", "The page did not finish streaming in time");
    } catch (error) {
      if (error instanceof HelperError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("请求超时")) {
        throw buildFailure("TIMEOUT", "The page did not finish streaming in time");
      }

      throw error;
    }
  }

  private async sendQwenChatPrompt(input: {
    tabId: string;
    prompt: string;
    timeoutMs: number;
    freshSession?: boolean;
  }): Promise<SendChatResult> {
    let baselineReply = "";
    let latestReply = "";
    let finalReply = "";
    let completionObserved = false;
    const trace = isBrowserAutomationDebugEnabled() ? [] : null;

    const buildFailure = (
      code: HelperError["code"],
      message: string,
    ) =>
      new HelperError(
        code,
        message,
        buildAutomationDebug({
          source: "bridge_stream",
          freshSession: input.freshSession === true,
          baselineReply,
          latestReply,
          finalReply,
          completionObserved,
          startMode: "transport_submit",
          trace,
        }),
      );

    await this.transport.evaluate(input.tabId, INJECTED_QWEN_BRIDGE_SOURCE);
    const baselineState = await this.transport.evaluate<PageStateSummary>(
      input.tabId,
      QWEN_PAGE_STATE_SCRIPT,
    );

    if (!baselineState.inputReady) {
      throw buildFailure(
        "PAGE_UNAVAILABLE",
        "Qwen chat composer is not ready",
      );
    }

    baselineReply = (baselineState.latestAssistantPreview ?? "").trim();
    await this.transport.evaluate(input.tabId, QWEN_RESET_COMPLETION_SCRIPT);
    await this.transport.submitPrompt(input.tabId, input.prompt);

    const startedAt = Date.now();
    const idleTimeoutMs = input.timeoutMs;
    const hardTimeoutMs = Math.max(input.timeoutMs * 4, 120_000);
    let lastProgressAt = startedAt;
    let previousStatus: string | null = null;
    let previousClosed: boolean | null = null;
    let previousTurnPreview = "";

    while (Date.now() - startedAt < hardTimeoutMs) {
      const progress = await this.transport.evaluate<{
        pageState: PageStateSummary;
        completionState: {
          observed?: boolean;
          status?: string;
          closed?: boolean;
          bodyPreview?: string | null;
          parserSummary?: string | null;
          turn?:
            | {
                mode: "text";
                outputText: string;
                thinkingText?: string;
              }
            | {
                mode: "native_tool_call";
                toolCall: {
                  name: string;
                  argumentsJson: string;
                };
                outputText?: string;
                thinkingText?: string;
              }
            | null;
        };
      }>(input.tabId, QWEN_PROGRESS_SCRIPT);

      completionObserved =
        completionObserved || progress.completionState?.observed === true;
      latestReply = (progress.pageState.latestAssistantPreview ?? "").trim();
      pushAutomationTrace(trace, {
        phase: "qwen_poll",
        pageBusy: progress.pageState.busy,
        pageReplyPreview: previewDebugText(progress.pageState.latestAssistantPreview),
        assistantCount: progress.pageState.assistantCount,
        completionStatus:
          typeof progress.completionState?.status === "string"
            ? progress.completionState.status
            : null,
        completionClosed:
          typeof progress.completionState?.closed === "boolean"
            ? progress.completionState.closed
            : undefined,
        completionObserved:
          typeof progress.completionState?.observed === "boolean"
            ? progress.completionState.observed
            : undefined,
        completionTurnMode:
          progress.completionState?.turn && typeof progress.completionState.turn.mode === "string"
            ? progress.completionState.turn.mode
            : null,
        completionTurnPreview:
          progress.completionState?.turn?.outputText
            ? previewDebugText(progress.completionState.turn.outputText)
            : null,
        note: [
          typeof progress.completionState?.parserSummary === "string"
            ? `parser=${progress.completionState.parserSummary}`
            : null,
          typeof progress.completionState?.bodyPreview === "string" &&
          progress.completionState.bodyPreview.length > 0
            ? `body=${previewDebugText(progress.completionState.bodyPreview)}`
            : null,
        ]
          .filter((entry) => entry)
          .join(" | ") || undefined,
      });

      const streamedTurn = progress.completionState?.turn;
      const terminalObserved =
        progress.completionState?.status === "finished" ||
        progress.completionState?.closed === true;
      const nextStatus =
        typeof progress.completionState?.status === "string"
          ? progress.completionState.status
          : null;
      const nextClosed =
        typeof progress.completionState?.closed === "boolean"
          ? progress.completionState.closed
          : null;
      const nextTurnPreview =
        typeof streamedTurn?.outputText === "string" ? streamedTurn.outputText : "";
      const hasCompletionProgress =
        progress.completionState?.observed === true &&
        (
          nextStatus === "streaming" ||
          nextStatus !== previousStatus ||
          nextClosed !== previousClosed ||
          nextTurnPreview !== previousTurnPreview
        );

      if (hasCompletionProgress || progress.pageState.busy) {
        lastProgressAt = Date.now();
      }
      previousStatus = nextStatus;
      previousClosed = nextClosed;
      previousTurnPreview = nextTurnPreview;

      if (
        terminalObserved &&
        streamedTurn?.mode === "native_tool_call" &&
        streamedTurn.toolCall
      ) {
        finalReply = (streamedTurn.outputText ?? "").trim();
        return {
          mode: "native_tool_call",
          ...(streamedTurn.thinkingText
            ? { thinkingText: streamedTurn.thinkingText }
            : {}),
          toolCall: streamedTurn.toolCall,
          ...(finalReply.length > 0 ? { outputText: finalReply } : {}),
          debug: buildAutomationDebug({
            source: "bridge_stream",
            freshSession: input.freshSession === true,
            baselineReply,
            latestReply,
            finalReply,
            completionObserved,
            startMode: "transport_submit",
            trace,
          }),
          modelLabel: "Qwen Web",
        };
      }

      if (
        terminalObserved &&
        streamedTurn?.mode === "text" &&
        streamedTurn.outputText
      ) {
        finalReply = streamedTurn.outputText.trim();
        return {
          mode: "text",
          ...(streamedTurn.thinkingText
            ? { thinkingText: streamedTurn.thinkingText }
            : {}),
          outputText: finalReply,
          debug: buildAutomationDebug({
            source: "bridge_stream",
            freshSession: input.freshSession === true,
            baselineReply,
            latestReply,
            finalReply,
            completionObserved,
            startMode: "transport_submit",
            trace,
          }),
          modelLabel: "Qwen Web",
        };
      }

      if (Date.now() - lastProgressAt >= idleTimeoutMs) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    throw buildFailure("TIMEOUT", "The page did not finish streaming in time");
  }
}

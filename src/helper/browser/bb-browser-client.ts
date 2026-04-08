import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HelperError } from "../errors";
import type { BrowserAutomationClient, BindResult, SendChatResult } from "./types";
import { assertDeepSeekUrl, INJECTED_BRIDGE_SOURCE } from "./deepseek-page-bridge";

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
  openDeepSeek(url: string): Promise<void>;
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
  };
}

export class BbBrowserClient implements BrowserAutomationClient {
  constructor(private readonly transport: BbBrowserTransport) {}

  async getConnectionStatus() {
    return this.transport.getConnectionStatus();
  }

  async bindDeepSeekTab(): Promise<BindResult> {
    let tab: { id: string; url: string };

    try {
      tab = await this.transport.findDeepSeekTab();
    } catch (error) {
      if (error instanceof HelperError && error.code === "NOT_BOUND") {
        await this.transport.openDeepSeek("https://chat.deepseek.com");
        throw new HelperError(
          "NOT_BOUND",
          "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
        );
      }

      if (
        error instanceof Error &&
        error.message.toLowerCase().includes("no page target found")
      ) {
        await this.transport.openDeepSeek("https://chat.deepseek.com");
        throw new HelperError(
          "NOT_BOUND",
          "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
        );
      }

      throw error;
    }

    const normalizedUrl = assertDeepSeekUrl(tab.url);

    await this.transport.evaluate(tab.id, INJECTED_BRIDGE_SOURCE);

    return {
      tabId: tab.id,
      url: normalizedUrl,
      loginState: "logged_in",
      bridgeInjected: true,
      pageState: {
        inputReady: true,
        busy: false,
        latestAssistantPreview: null,
        assistantCount: 0,
      },
    };
  }

  async resetPageBridge(tabId: string): Promise<void> {
    await this.transport.evaluate<boolean>(
      tabId,
      "(() => { try { delete window.__piDeepSeekBridge; } catch {} window.__piDeepSeekBridge = undefined; return true; })()",
    );
  }

  async sendChatPrompt(input: {
    tabId: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<SendChatResult> {
    const promptLiteral = JSON.stringify(input.prompt);
    const bridgeSendScript = `${INJECTED_BRIDGE_SOURCE}; window.__piDeepSeekBridge.sendPrompt({ prompt: ${promptLiteral}, timeoutMs: ${input.timeoutMs} })`;
    const pageStateScript = `${INJECTED_BRIDGE_SOURCE}; window.__piDeepSeekBridge.getPageState()`;

    try {
      const bridgeResult = await this.transport.evaluate<{
        ok?: boolean;
        reply?: string;
        error?: string;
        message?: string;
        inputReady?: boolean;
        busy?: boolean;
        latestAssistantPreview?: string | null;
        assistantCount?: number;
        blockingMessage?: string | null;
      }>(input.tabId, bridgeSendScript);

      if (bridgeResult && typeof bridgeResult === "object" && "ok" in bridgeResult) {
        if (bridgeResult.ok && typeof bridgeResult.reply === "string") {
          return {
            reply: bridgeResult.reply,
            modelLabel: "DeepSeek Web",
          };
        }

        if (bridgeResult.error === "PAGE_UNAVAILABLE") {
          throw new HelperError(
            "PAGE_UNAVAILABLE",
            bridgeResult.message ??
              "DeepSeek requires manual verification in the browser tab before chatting",
          );
        }

        if (bridgeResult.error === "TIMEOUT") {
          throw new HelperError(
            "TIMEOUT",
            bridgeResult.message ?? "The page did not finish streaming in time",
          );
        }

        if (bridgeResult.error) {
          throw new HelperError(
            "AUTOMATION_DESYNC",
            bridgeResult.message ?? bridgeResult.error,
          );
        }
      }

      const baselineState =
        bridgeResult &&
        typeof bridgeResult === "object" &&
        "latestAssistantPreview" in bridgeResult &&
        "assistantCount" in bridgeResult
          ? {
              inputReady: bridgeResult.inputReady ?? true,
              busy: bridgeResult.busy ?? false,
              latestAssistantPreview: bridgeResult.latestAssistantPreview ?? null,
              assistantCount: bridgeResult.assistantCount ?? 0,
              blockingMessage: bridgeResult.blockingMessage ?? null,
            }
          : await this.transport.evaluate<{
        inputReady: boolean;
        busy: boolean;
        latestAssistantPreview: string | null;
        assistantCount: number;
        blockingMessage?: string | null;
      }>(input.tabId, pageStateScript);

      if (baselineState.blockingMessage) {
        throw new HelperError(
          "PAGE_UNAVAILABLE",
          "DeepSeek requires manual verification in the browser tab before chatting",
        );
      }

      await this.transport.submitPrompt(input.tabId, input.prompt);

      const baselineReply = (baselineState.latestAssistantPreview ?? "").trim();
      const baselineAssistantCount = baselineState.assistantCount;
      const startedAt = Date.now();
      const idleTimeoutMs = input.timeoutMs;
      const hardTimeoutMs = Math.max(input.timeoutMs * 4, 120_000);
      let lastProgressAt = startedAt;
      let latestReply = "";
      let previousReply = baselineReply;
      let previousAssistantCount = baselineAssistantCount;
      let sawFreshReply = false;
      let stableCount = 0;

      while (Date.now() - startedAt < hardTimeoutMs) {
        const state = await this.transport.evaluate<{
          inputReady: boolean;
          busy: boolean;
          latestAssistantPreview: string | null;
          assistantCount: number;
          blockingMessage?: string | null;
        }>(input.tabId, pageStateScript);

        if (state.blockingMessage) {
          throw new HelperError(
            "PAGE_UNAVAILABLE",
            "DeepSeek requires manual verification in the browser tab before chatting",
          );
        }

        const nextReply = (state.latestAssistantPreview ?? "").trim();
        const assistantCountIncreased = state.assistantCount > previousAssistantCount;
        const replyChanged = nextReply !== previousReply;
        const hasProgress = assistantCountIncreased || replyChanged || state.busy;
        const hasFreshReply =
          state.assistantCount > baselineAssistantCount ||
          (nextReply.length > 0 && nextReply !== baselineReply);

        if (hasProgress) {
          lastProgressAt = Date.now();
          previousAssistantCount = state.assistantCount;
          previousReply = nextReply;
        }

        if (hasFreshReply) {
          sawFreshReply = true;
          if (nextReply.length > 0) {
            latestReply = nextReply;
          }

          if (replyChanged) {
            stableCount = 0;
          } else {
            stableCount += 1;
          }
        }

        if (sawFreshReply && !state.busy && stableCount >= 2) {
          return {
            reply: latestReply || nextReply,
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
        throw new HelperError(
          "PAGE_UNAVAILABLE",
          "DeepSeek requires manual verification in the browser tab before chatting",
        );
      }

      const finalReply = (finalState.latestAssistantPreview ?? "").trim();
      const hasRecoveredReply =
        finalState.assistantCount > baselineAssistantCount ||
        (finalReply.length > 0 && finalReply !== baselineReply);

      if (hasRecoveredReply) {
        return {
          reply: finalReply || latestReply,
          modelLabel: "DeepSeek Web",
        };
      }

      throw new HelperError("TIMEOUT", "The page did not finish streaming in time");
    } catch (error) {
      if (error instanceof HelperError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("请求超时")) {
        throw new HelperError("TIMEOUT", "The page did not finish streaming in time");
      }

      throw error;
    }
  }
}

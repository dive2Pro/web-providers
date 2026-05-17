import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  assertQwenUrl,
  INJECTED_QWEN_BRIDGE_SOURCE,
  QWEN_PAGE_STATE_SCRIPT,
  QWEN_PROGRESS_SCRIPT,
  QWEN_RESET_COMPLETION_SCRIPT,
  QWEN_START_NEW_CHAT_SCRIPT,
} from "../providers/qwen/page-bridge";
import { resolveDeepSeekPageMode } from "../types";

const require = createRequire(import.meta.url);

type BbBrowserInvocation = {
  command: string;
  argsPrefix: string[];
};

export function resolveBbBrowserInvocation(input?: {
  resolvePackageJson?: () => string;
  loadPackageJson?: (packageJsonPath: string) => { bin?: string | Record<string, string> };
}): BbBrowserInvocation {
  try {
    const packageJsonPath =
      input?.resolvePackageJson?.() ?? require.resolve("bb-browser/package.json");
    const packageJson =
      input?.loadPackageJson?.(packageJsonPath) ??
      (require(packageJsonPath) as { bin?: string | Record<string, string> });
    const bin =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.["bb-browser"];

    if (typeof bin === "string" && bin.length > 0) {
      const packageRoot = toExecutablePackageRoot(dirname(packageJsonPath));
      return {
        command: process.execPath,
        argsPrefix: [join(packageRoot, bin)],
      };
    }
  } catch {
    // Fall back to the global command when the package is not installed locally.
  }

  return {
    command: "bb-browser",
    argsPrefix: [],
  };
}

function toExecutablePackageRoot(packageRoot: string) {
  if (!packageRoot.includes(".asar/") && !packageRoot.includes(".asar\\")) {
    return packageRoot;
  }

  const unpackedRoot = packageRoot.replace(
    /\.asar([\\/])/,
    ".asar.unpacked$1",
  );
  return existsSync(unpackedRoot) ? unpackedRoot : packageRoot;
}

const BB_BROWSER_INVOCATION = resolveBbBrowserInvocation();

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
  getTab?(tabId: string): Promise<{ id: string; url: string }>;
  findTabByUrl?(url: string): Promise<{ id: string; url: string } | null>;
  findDeepSeekTab(): Promise<{ id: string; url: string }>;
  findQwenTab?(): Promise<{ id: string; url: string }>;
  openDeepSeek(url: string): Promise<{ id: string; url: string } | void>;
  openQwen?(url: string): Promise<{ id: string; url: string } | void>;
  evaluate<T>(tabId: string, script: string): Promise<T>;
  submitPrompt(tabId: string, prompt: string): Promise<void>;
}

function isTransientDeepSeekBlockingMessage(message: string | null | undefined) {
  return (
    message === "DeepSeek tab is still loading. Wait for the page to finish loading." ||
    message ===
      "DeepSeek finished loading an empty page in the embedded browser. Reload the page or sign in manually, then retry."
  );
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

export function normalizeBbBrowserEvalScript(script: string) {
  return script.replace(/\r?\n+/g, " ").trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrlForMatch(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

export function extractDeepSeekTextboxRefFromSnapshot(snapshotText: string) {
  const namedTextboxRef = snapshotText.match(
    /textbox \[ref=(\d+)\] "Message DeepSeek"/i,
  )?.[1];
  const textboxMatches = Array.from(snapshotText.matchAll(/textbox \[ref=(\d+)\]/g));
  const fallbackTextboxRef = textboxMatches.at(-1)?.[1];

  return namedTextboxRef ?? fallbackTextboxRef ?? null;
}

export function findOpenedTabFromSnapshots(
  before: Array<{ index: number; id: string; url: string }>,
  after: Array<{ index: number; id: string; url: string }>,
  matcher: (tab: { index: number; id: string; url: string }) => boolean,
) {
  const beforeById = new Map(before.map((tab) => [tab.id, tab]));

  return after.find((candidate) => {
    if (!matcher(candidate)) {
      return false;
    }

    const previous = beforeById.get(candidate.id);
    if (!previous) {
      return true;
    }

    return previous.url !== candidate.url;
  });
}

async function waitForOpenedTab(input: {
  listTabs: () => Promise<Array<{ index: number; id: string; url: string }>>;
  before: Array<{ index: number; id: string; url: string }>;
  matcher: (tab: { index: number; id: string; url: string }) => boolean;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? 3_000;
  const pollMs = input.pollMs ?? 100;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const after = await input.listTabs();
    const opened = findOpenedTabFromSnapshots(input.before, after, input.matcher);
    if (opened) {
      return opened;
    }

    await sleep(pollMs);
  }

  return undefined;
}

function execBbBrowser(args: string[], options?: { maxBuffer?: number }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      BB_BROWSER_INVOCATION.command,
      [...BB_BROWSER_INVOCATION.argsPrefix, ...args],
      {
        encoding: "utf8",
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

async function runBbBrowserJson(args: string[]) {
  const { stdout, stderr, error } = await new Promise<{
    stdout: string;
    stderr: string;
    error: Error | null;
  }>((resolve) => {
    execFile(
      BB_BROWSER_INVOCATION.command,
      [...BB_BROWSER_INVOCATION.argsPrefix, ...args, "--json"],
      {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
      (callbackError, callbackStdout, callbackStderr) => {
        resolve({
          stdout: callbackStdout,
          stderr: callbackStderr,
          error: callbackError,
        });
      },
    );
  });
  const stdoutText = stdout;
  try {
    const parsed = JSON.parse(stdoutText) as unknown;
    if (error) {
      return parsed;
    }
    return parsed;
  } catch (parseError) {
    if (error) {
      throw new Error(stderr.trim() || error.message);
    }
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    const preview = stdoutText.slice(0, 300).replace(/\s+/g, " ");
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

    async findTabByUrl(url: string) {
      const list = await listTabs();
      const normalizedTarget = normalizeUrlForMatch(url);
      return (
        list.find((entry) => normalizeUrlForMatch(entry.url) === normalizedTarget) ??
        null
      );
    },

    async findQwenTab() {
      const list = await listTabs();
      const tab = list.find((entry) => entry.url.includes("chat.qwen.ai"));

      if (!tab) {
        throw new HelperError("NOT_BOUND", "No logged-in Qwen tab is available");
      }

      return tab;
    },

    async getTab(tabId: string) {
      const list = await listTabs();
      const tab = list.find((entry) => entry.id === tabId);

      if (!tab) {
        throw new HelperError("NOT_BOUND", `No browser tab is available for ${tabId}`);
      }

      return tab;
    },

    async evaluate<T>(tabId: string, script: string): Promise<T> {
      await selectTabById(tabId);
      const raw = await runBbBrowserJson(["eval", normalizeBbBrowserEvalScript(script)]);
      return unwrapEvalResult<T>(raw);
    },

    async submitPrompt(tabId: string, prompt: string) {
      await selectTabById(tabId);

      const startedAt = Date.now();
      const timeoutMs = 3_000;
      const pollMs = 150;
      let textboxRef: string | null = null;

      while (Date.now() - startedAt <= timeoutMs) {
        const { stdout: scopedSnapshotText } = await execBbBrowser(
          ["snapshot", "-i", "-s", "textarea"],
          {
            maxBuffer: 20 * 1024 * 1024,
          },
        );
        textboxRef = extractDeepSeekTextboxRefFromSnapshot(scopedSnapshotText);

        if (!textboxRef) {
          const { stdout: fullSnapshotText } = await execBbBrowser(
            ["snapshot", "-i"],
            {
              maxBuffer: 20 * 1024 * 1024,
            },
          );
          textboxRef = extractDeepSeekTextboxRefFromSnapshot(fullSnapshotText);
        }

        if (textboxRef) {
          break;
        }

        await sleep(pollMs);
      }

      if (!textboxRef) {
        throw new Error(
          "DeepSeek composer textbox not found in snapshot; the tab may still be loading or blocked by verification",
        );
      }

      await execBbBrowser(["fill", textboxRef, prompt], {
        maxBuffer: 20 * 1024 * 1024,
      });
      await execBbBrowser(["press", "Enter"], {
        maxBuffer: 20 * 1024 * 1024,
      });
    },

    async openDeepSeek(url: string) {
      const before = await listTabs();
      await runBbBrowserJson(["open", url]);
      return waitForOpenedTab({
        before,
        listTabs,
        matcher: (candidate) => candidate.url.includes("deepseek.com"),
      });
    },

    async openQwen(url: string) {
      const before = await listTabs();
      await runBbBrowserJson(["open", url]);
      return waitForOpenedTab({
        before,
        listTabs,
        matcher: (candidate) => candidate.url.includes("chat.qwen.ai"),
      });
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

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Operation aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

  async getProviderTabUrl(input: {
    provider: "deepseek-web" | "qwen-web";
    tabId: string;
  }) {
    try {
      const tab = await this.transport.getTab?.(input.tabId);
      if (!tab) {
        return null;
      }

      return input.provider === "qwen-web"
        ? assertQwenUrl(tab.url)
        : assertDeepSeekUrl(tab.url);
    } catch {
      return null;
    }
  }

  async bindProviderTab(input: {
    provider: "deepseek-web" | "qwen-web";
    tabId?: string;
    openNew?: boolean;
    openUrl?: string;
    passive?: boolean;
  }): Promise<BindResult> {
    return this.providerRegistry[input.provider].bindTab({
      tabId: input.tabId,
      openNew: input.openNew,
      openUrl: input.openUrl,
      passive: input.passive,
    });
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
          modelId?: string;
        },
  ): Promise<void> {
    if (typeof input !== "string" && input.provider === "qwen-web") {
      await this.transport.evaluate(input.tabId, QWEN_START_NEW_CHAT_SCRIPT);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await this.transport.evaluate(input.tabId, INJECTED_QWEN_BRIDGE_SOURCE);
      return;
    }

    const tabId = typeof input === "string" ? input : input.tabId;
    const targetModelType =
      typeof input === "string" ? null : resolveDeepSeekPageMode(input.modelId);
    const previousTab = this.transport.getTab
      ? await this.transport.getTab(tabId).catch(() => null)
      : null;
    const previousUrl = previousTab?.url ?? "";
    const openFreshChatScript =
      `${INJECTED_BRIDGE_SOURCE}; window.__piDeepSeekBridge.openFreshChat()`;
    const pageStateScript =
      `${INJECTED_BRIDGE_SOURCE}; window.__piDeepSeekBridge.getPageState()`;
    try {
      const result = await this.transport.evaluate<{
        ok?: boolean;
        error?: string;
        message?: string;
      }>(
        tabId,
        openFreshChatScript,
      );
      if (result?.ok === false) {
        throw new HelperError(
          result.error === "PAGE_UNAVAILABLE" ? "PAGE_UNAVAILABLE" : "AUTOMATION_DESYNC",
          result.message ?? result.error ?? "Failed to start a new DeepSeek chat",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isExpectedNavigation =
        message.includes("Inspected target navigated or closed") ||
        message.includes("Execution context was destroyed");

      if (!isExpectedNavigation) {
        throw error;
      }
    }

    const previousPathname = (() => {
      try {
        return new URL(previousUrl).pathname.toLowerCase();
      } catch {
        return "";
      }
    })();
    const shouldRequireRouteChange =
      previousPathname.startsWith("/a/chat/s/");
    const startedAt = Date.now();
    const timeoutMs = 12_000;
    let lastPageState: PageStateSummary | null = null;

    while (Date.now() - startedAt <= timeoutMs) {
      const pageState = await this.transport.evaluate<PageStateSummary | undefined>(
        tabId,
        pageStateScript,
      );
      if (!pageState || typeof pageState !== "object") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      lastPageState = pageState;

      if (
        pageState.blockingMessage &&
        !isTransientDeepSeekBlockingMessage(pageState.blockingMessage)
      ) {
        throw new HelperError("PAGE_UNAVAILABLE", pageState.blockingMessage);
      }

      const currentPathname = pageState.diagnostics?.locationPath?.toLowerCase() ?? "";
      const routeChanged =
        !shouldRequireRouteChange || currentPathname !== previousPathname;
      if (pageState.inputReady && !pageState.busy && routeChanged) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    if (!(lastPageState?.inputReady && !lastPageState.busy)) {
      throw new HelperError(
        "AUTOMATION_DESYNC",
        "DeepSeek new chat did not finish resetting the page",
      );
    }

    if (targetModelType) {
      const result = await this.transport.evaluate<{
        ok?: boolean;
        error?: string;
        message?: string;
      }>(
        tabId,
        `${INJECTED_BRIDGE_SOURCE}; window.__piDeepSeekBridge.setModelType(${JSON.stringify({ targetModelType })})`,
      );
      if (result?.ok === false) {
        throw new HelperError(
          result.error === "PAGE_UNAVAILABLE" ? "PAGE_UNAVAILABLE" : "AUTOMATION_DESYNC",
          result.message ?? result.error ?? "Failed to switch the DeepSeek mode",
        );
      }
    }
  }

  async sendChatPrompt(input: {
    provider?: "deepseek-web" | "qwen-web";
    tabId: string;
    prompt: string;
    timeoutMs: number;
    freshSession?: boolean;
    signal?: AbortSignal;
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
    let bridgeStartObserved = false;
    let sawPostSubmitProgress = false;
    let shouldFallbackToTransportSubmit = false;
    const readProgressSnapshot = async () => {
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
        inputReady?: boolean;
        busy?: boolean;
        latestAssistantPreview?: string | null;
        assistantCount?: number;
        blockingMessage?: string | null;
      }>(input.tabId, progressScript);
      const pageState =
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
                  typeof progress.blockingMessage === "string" ||
                  progress.blockingMessage === null
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

      return {
        pageState,
        completionState,
      };
    };
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
    const waitForTransportSubmissionStart = async (baselineAssistantCount: number) => {
      const startedAt = Date.now();
      const timeoutMs = 1_200;

      while (Date.now() - startedAt < timeoutMs) {
        throwIfAborted(input.signal);
        const { pageState, completionState } = await readProgressSnapshot();
        completionObserved = completionObserved || completionState?.observed === true;

        pushAutomationTrace(trace, {
          phase: "confirm_start",
          pageBusy: pageState.busy,
          pageReplyPreview: previewDebugText(pageState.latestAssistantPreview),
          assistantCount: pageState.assistantCount,
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
        });

        if (pageState.blockingMessage) {
          throw buildFailure(
            "PAGE_UNAVAILABLE",
            "DeepSeek requires manual verification in the browser tab before chatting",
          );
        }

        if (
          completionState?.observed === true ||
          (typeof completionState?.status === "string" &&
            completionState.status !== "idle") ||
          pageState.busy ||
          pageState.assistantCount > baselineAssistantCount
        ) {
          return;
        }

        await abortableDelay(100, input.signal);
      }

      throw buildFailure(
        "AUTOMATION_DESYNC",
        "Prompt submission did not start a DeepSeek response",
      );
    };

    try {
      throwIfAborted(input.signal);
      const startResult = await this.transport.evaluate<{
        ok?: boolean;
        baselineState?: {
          inputReady?: boolean;
          busy?: boolean;
          latestAssistantPreview?: string | null;
          assistantCount?: number;
          activityAt?: number | null;
          blockingMessage?: string | null;
        };
        startObserved?: boolean;
        submissionMethod?: string;
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
            activityAt: startResult.baselineState.activityAt ?? null,
            blockingMessage: startResult.baselineState.blockingMessage ?? null,
          }
        : await this.transport.evaluate<{
            inputReady: boolean;
            busy: boolean;
            latestAssistantPreview: string | null;
            assistantCount: number;
            activityAt?: number | null;
            blockingMessage?: string | null;
          }>(input.tabId, pageStateScript);

      bridgeStartObserved =
        startResult && typeof startResult === "object" && startResult.ok === true
          ? startResult.startObserved === true
          : false;

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
        throwIfAborted(input.signal);
        await this.transport.submitPrompt(input.tabId, input.prompt);
        await waitForTransportSubmissionStart(baselineState.assistantCount);
      }

      baselineReply = (baselineState.latestAssistantPreview ?? "").trim();
      const baselineAssistantCount = baselineState.assistantCount;
      const startedAt = Date.now();
      const idleTimeoutMs = input.timeoutMs;
      const hardTimeoutMs = Math.max(input.timeoutMs * 4, 120_000);
      let lastProgressAt = startedAt;
      let lastHardProgressAt = startedAt;
      let previousReply = baselineReply;
      let previousAssistantCount = baselineAssistantCount;
      let previousActivityAt =
        typeof baselineState.activityAt === "number" ? baselineState.activityAt : 0;
      let previousCompletionStatus: string | null = null;
      let previousCompletionClosed: boolean | null = null;
      let previousCompletionTurnPreview = "";

      while (Date.now() - lastHardProgressAt < hardTimeoutMs) {
        throwIfAborted(input.signal);
        const { pageState: state, completionState } = await readProgressSnapshot();
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
              ? previewDebugText(
                  completionState.turn.rawOutputText ?? completionState.turn.outputText,
                )
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
        const nextActivityAt = typeof state.activityAt === "number" ? state.activityAt : 0;
        const nextCompletionStatus =
          typeof completionState?.status === "string" ? completionState.status : null;
        const nextCompletionClosed =
          typeof completionState?.closed === "boolean" ? completionState.closed : null;
        const nextCompletionTurnPreview =
          typeof streamedTurn?.outputText === "string" ? streamedTurn.outputText : "";
        const completionStatusAdvanced =
          nextCompletionStatus !== previousCompletionStatus &&
          !(previousCompletionStatus === null && nextCompletionStatus === "idle");
        const completionClosedAdvanced =
          nextCompletionClosed !== previousCompletionClosed &&
          !(previousCompletionClosed === null && nextCompletionClosed === false);
        const pageActivityAdvanced = nextActivityAt > previousActivityAt;
        const completionProgressChanged =
          completionStatusAdvanced ||
          completionClosedAdvanced ||
          nextCompletionTurnPreview !== previousCompletionTurnPreview;
        const hasProgress =
          assistantCountIncreased ||
          replyChanged ||
          pageActivityAdvanced ||
          completionProgressChanged;
        if (hasProgress) {
          const now = Date.now();
          lastProgressAt = now;
          lastHardProgressAt = now;
          sawPostSubmitProgress = true;
          previousAssistantCount = state.assistantCount;
          previousReply = nextReply;
        }
        previousActivityAt = Math.max(previousActivityAt, nextActivityAt);
        previousCompletionStatus = nextCompletionStatus;
        previousCompletionClosed = nextCompletionClosed;
        previousCompletionTurnPreview = nextCompletionTurnPreview;

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
            completionTurnPreview: previewDebugText(
              streamedTurn.rawOutputText ?? streamedTurn.outputText,
            ),
          });
          return {
            mode: "text",
            ...(typeof streamedTurn.thinkingText === "string"
              ? { thinkingText: streamedTurn.thinkingText }
              : {}),
            outputText: streamedTurn.outputText,
            ...(typeof streamedTurn.rawOutputText === "string"
              ? { rawOutputText: streamedTurn.rawOutputText }
              : {}),
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
          if (!bridgeStartObserved && !completionObserved && !sawPostSubmitProgress) {
            throw buildFailure(
              "AUTOMATION_DESYNC",
              "Prompt submission did not start a DeepSeek response",
            );
          }
          break;
        }

        await abortableDelay(300, input.signal);
      }

      throwIfAborted(input.signal);
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
    signal?: AbortSignal;
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

    throwIfAborted(input.signal);
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
    throwIfAborted(input.signal);
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
      throwIfAborted(input.signal);
      const progress = await this.transport.evaluate<{
        pageState: PageStateSummary;
        completionState: {
          observed?: boolean;
          status?: string;
          closed?: boolean;
          parserSummary?: string | null;
          turn?:
            | {
                mode: "text";
                outputText: string;
                thinkingText?: string;
              }
            | {
                mode: "native_tool_call";
                toolCalls: Array<{
                  name: string;
                  argumentsJson: string;
                }>;
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
        streamedTurn.toolCalls.length > 0
      ) {
        finalReply = (streamedTurn.outputText ?? "").trim();
        return {
          mode: "native_tool_call",
          ...(streamedTurn.thinkingText
            ? { thinkingText: streamedTurn.thinkingText }
            : {}),
          toolCalls: streamedTurn.toolCalls,
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

      await abortableDelay(300, input.signal);
    }

    throw buildFailure("TIMEOUT", "The page did not finish streaming in time");
  }
}

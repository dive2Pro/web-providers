import { describe, expect, it } from "vitest";
import { HelperError } from "../../src/helper/errors";
import {
  BbBrowserClient,
  extractDeepSeekTextboxRefFromSnapshot,
  extractTabsFromTabList,
  findOpenedTabFromSnapshots,
  normalizeBbBrowserEvalScript,
  resolveBbBrowserInvocation,
  unwrapEvalResult,
} from "../../src/helper/browser/bb-browser-client";

describe("BbBrowserClient", () => {
  it("extracts tabs from bb-browser tab list envelopes", () => {
    expect(
      extractTabsFromTabList({
        id: "req-1",
        success: true,
        data: {
          tabs: [
            {
              index: 0,
              url: "about:blank",
              title: "about:blank",
              active: true,
              tabId: "tab-blank",
            },
            {
              index: 1,
              url: "https://chat.deepseek.com",
              title: "DeepSeek",
              active: false,
              tabId: "tab-deepseek",
            },
          ],
          activeIndex: 0,
        },
      }),
    ).toEqual([
      { index: 0, id: "tab-blank", url: "about:blank" },
      { index: 1, id: "tab-deepseek", url: "https://chat.deepseek.com" },
    ]);
  });

  it("unwraps bb-browser eval envelopes to the nested result payload", () => {
    expect(
      unwrapEvalResult({
        id: "req-2",
        success: true,
        data: {
          result: {
            ok: true,
            reply: "hello",
          },
        },
      }),
    ).toEqual({
      ok: true,
      reply: "hello",
    });
  });

  it("extracts the DeepSeek textbox ref from scoped or full snapshots", () => {
    expect(
      extractDeepSeekTextboxRefFromSnapshot(
        '标题: DeepSeek\ntextbox [ref=21] "Message DeepSeek"\nbutton [ref=22]',
      ),
    ).toBe("21");

    expect(
      extractDeepSeekTextboxRefFromSnapshot(
        "div [ref=0]\ntextbox [ref=9]\nbutton [ref=10]",
      ),
    ).toBe("9");

    expect(extractDeepSeekTextboxRefFromSnapshot("div [ref=0]\nbutton [ref=1]")).toBeNull();
  });

  it("detects a newly opened matching tab or a tab navigated into the provider page", () => {
    expect(
      findOpenedTabFromSnapshots(
        [{ index: 0, id: "tab-blank", url: "about:blank" }],
        [{ index: 0, id: "tab-blank", url: "https://chat.deepseek.com/" }],
        (tab) => tab.url.includes("deepseek.com"),
      ),
    ).toEqual({
      index: 0,
      id: "tab-blank",
      url: "https://chat.deepseek.com/",
    });

    expect(
      findOpenedTabFromSnapshots(
        [{ index: 0, id: "tab-blank", url: "about:blank" }],
        [
          { index: 0, id: "tab-blank", url: "about:blank" },
          { index: 1, id: "tab-deepseek", url: "https://chat.deepseek.com/" },
        ],
        (tab) => tab.url.includes("deepseek.com"),
      ),
    ).toEqual({
      index: 1,
      id: "tab-deepseek",
      url: "https://chat.deepseek.com/",
    });
  });

  it("resolves the project-local bb-browser cli when the package is installed", () => {
    expect(
      resolveBbBrowserInvocation({
        resolvePackageJson: () => "/tmp/project/node_modules/bb-browser/package.json",
        loadPackageJson: () => ({
          bin: {
            "bb-browser": "dist/cli.js",
          },
        }),
      }),
    ).toEqual({
      command: process.execPath,
      argsPrefix: ["/tmp/project/node_modules/bb-browser/dist/cli.js"],
    });
  });

  it("falls back to the global bb-browser command when the local package is unavailable", () => {
    expect(
      resolveBbBrowserInvocation({
        resolvePackageJson: () => {
          throw new Error("module not found");
        },
      }),
    ).toEqual({
      command: "bb-browser",
      argsPrefix: [],
    });
  });

  it("flattens multiline eval scripts before sending them to bb-browser", () => {
    expect(
      normalizeBbBrowserEvalScript('\n(() => {\n  const value = "x";\n  return value;\n})()\n'),
    ).toBe('(() => {   const value = "x";   return value; })()');
  });

  it("binds a DeepSeek tab and injects the page bridge", async () => {
    const evaluations: Array<{ tabId: string; script: string }> = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(tabId: string, script: string) => {
        evaluations.push({ tabId, script });
        if (script.includes("getPageState()")) {
          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
            blockingMessage: null,
          } as T;
        }
        return undefined as T;
      },
    });

    const result = await client.bindDeepSeekTab();

    expect(result).toEqual({
      tabId: "tab-1",
      url: "https://chat.deepseek.com/",
      loginState: "logged_in",
      bridgeInjected: true,
      pageState: {
        inputReady: true,
        busy: false,
        latestAssistantPreview: null,
        assistantCount: 0,
        blockingMessage: null,
      },
    });
    expect(evaluations).toHaveLength(2);
    expect(evaluations[0]?.tabId).toBe("tab-1");
  });

  it("binds a DeepSeek tab through provider dispatch", async () => {
    const evaluations: Array<{ tabId: string; script: string }> = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-deepseek",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(tabId: string, script: string) => {
        evaluations.push({ tabId, script });
        if (script.includes("getPageState()")) {
          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
            blockingMessage: null,
          } as T;
        }
        return undefined as T;
      },
    });

    const result = await client.bindProviderTab({ provider: "deepseek-web" });

    expect(result).toMatchObject({
      tabId: "tab-deepseek",
      url: "https://chat.deepseek.com/",
      loginState: "logged_in",
      bridgeInjected: true,
    });
    expect(evaluations).toHaveLength(2);
    expect(evaluations[0]?.tabId).toBe("tab-deepseek");
  });

  it("opens a fresh DeepSeek tab instead of reusing an existing tab with the same url", async () => {
    const opened: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findTabByUrl: async () => ({
        id: "tab-existing",
        url: "https://chat.deepseek.com/a/chat/s/existing-session",
      }),
      findDeepSeekTab: async () => ({
        id: "tab-fallback",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async (url: string) => {
        opened.push(url);
        return {
          id: "tab-fresh",
          url,
        };
      },
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("getPageState()")) {
          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
            blockingMessage: null,
          } as T;
        }

        return undefined as T;
      },
    });

    const result = await client.bindProviderTab({
      provider: "deepseek-web",
      openNew: true,
      openUrl: "https://chat.deepseek.com/a/chat/s/existing-session",
    });

    expect(result.tabId).toBe("tab-fresh");
    expect(opened).toEqual([
      "https://chat.deepseek.com/a/chat/s/existing-session",
    ]);
  });

  it("returns logged_out when the DeepSeek tab is still loading", async () => {
    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-loading",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("getPageState()")) {
          return {
            inputReady: false,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
            blockingMessage:
              "DeepSeek tab is still loading. Wait for the page to finish loading.",
          } as T;
        }
        return undefined as T;
      },
    });

    const result = await client.bindDeepSeekTab();

    expect(result).toMatchObject({
      loginState: "logged_out",
      pageState: {
        inputReady: false,
        blockingMessage:
          "DeepSeek tab is still loading. Wait for the page to finish loading.",
      },
    });
  });

  it("binds a Qwen tab through provider dispatch", async () => {
    const evaluations: Array<{ tabId: string; script: string }> = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-deepseek",
        url: "https://chat.deepseek.com/",
      }),
      findQwenTab: async () => ({
        id: "tab-qwen",
        url: "https://chat.qwen.ai/",
      }),
      openDeepSeek: async () => undefined,
      openQwen: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(tabId: string, script: string) => {
        evaluations.push({ tabId, script });
        return {
          inputReady: true,
          busy: false,
          latestAssistantPreview: null,
          assistantCount: 0,
        } as T;
      },
    } as never);

    const result = await client.bindProviderTab({ provider: "qwen-web" });

    expect(result).toMatchObject({
      tabId: "tab-qwen",
      url: "https://chat.qwen.ai/",
      loginState: "logged_in",
      bridgeInjected: true,
    });
    expect(evaluations[0]?.tabId).toBe("tab-qwen");
  });

  it("rejects non-DeepSeek tabs during bind", async () => {
    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://example.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>() => undefined as T,
    });

    await expect(client.bindDeepSeekTab()).rejects.toMatchObject({
      code: "PAGE_UNAVAILABLE",
    });
  });

  it("translates missing page-target errors into NOT_BOUND", async () => {
    const opened: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => {
        throw new Error("No page target found");
      },
      openDeepSeek: async (url: string) => {
        opened.push(url);
      },
      submitPrompt: async () => undefined,
      evaluate: async <T>() => undefined as T,
    });

    await expect(client.bindDeepSeekTab()).rejects.toEqual(
      new HelperError(
        "NOT_BOUND",
        "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
      ),
    );
    expect(opened).toEqual(["https://chat.deepseek.com"]);
  });

  it("opens DeepSeek when no DeepSeek tab is currently available", async () => {
    const opened: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => {
        throw new HelperError("NOT_BOUND", "No logged-in DeepSeek tab is available");
      },
      openDeepSeek: async (url: string) => {
        opened.push(url);
      },
      submitPrompt: async () => undefined,
      evaluate: async <T>() => undefined as T,
    });

    await expect(client.bindDeepSeekTab()).rejects.toEqual(
      new HelperError(
        "NOT_BOUND",
        "Opened DeepSeek in bb-browser. Finish login in that page and retry.",
      ),
    );
    expect(opened).toEqual(["https://chat.deepseek.com"]);
  });

  it("reopens a DeepSeek tab when bridge injection hits a missing page target", async () => {
    const opened: string[] = [];
    const evaluations: string[] = [];
    let currentTabId = "tab-stale";

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      getTab: async (tabId: string) => ({
        id: tabId,
        url: "https://chat.deepseek.com/",
      }),
      findDeepSeekTab: async () => ({
        id: currentTabId,
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async (url: string) => {
        opened.push(url);
        currentTabId = "tab-fresh";
        return {
          id: currentTabId,
          url: "https://chat.deepseek.com/",
        };
      },
      submitPrompt: async () => undefined,
      evaluate: async <T>(tabId: string, script: string) => {
        evaluations.push(`${tabId}:${script.slice(0, 20)}`);
        if (tabId === "tab-stale") {
          throw new Error("No page target found");
        }
        return undefined as T;
      },
    } as never);

    const result = await client.bindProviderTab({
      provider: "deepseek-web",
      tabId: "tab-stale",
    });

    expect(result.tabId).toBe("tab-fresh");
    expect(opened).toEqual(["https://chat.deepseek.com"]);
    expect(evaluations[0]).toContain("tab-stale");
    expect(evaluations[1]).toContain("tab-fresh");
  });

  it("does not open a new DeepSeek tab immediately when a remembered tab id is stale", async () => {
    const opened: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      getTab: async () => {
        throw new HelperError("NOT_BOUND", "No browser tab is available for tab-stale");
      },
      findDeepSeekTab: async () => {
        throw new HelperError("NOT_BOUND", "No logged-in DeepSeek tab is available");
      },
      openDeepSeek: async (url: string) => {
        opened.push(url);
      },
      submitPrompt: async () => undefined,
      evaluate: async <T>() => undefined as T,
    } as never);

    await expect(
      client.bindProviderTab({ provider: "deepseek-web", tabId: "tab-stale" }),
    ).rejects.toEqual(
      new HelperError("NOT_BOUND", "No browser tab is available for tab-stale"),
    );
    expect(opened).toEqual([]);
  });

  it("does not open a new Qwen tab immediately when a remembered tab id is stale", async () => {
    const opened: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      getTab: async () => {
        throw new HelperError("NOT_BOUND", "No browser tab is available for tab-stale");
      },
      findDeepSeekTab: async () => {
        throw new HelperError("NOT_BOUND", "No logged-in DeepSeek tab is available");
      },
      findQwenTab: async () => {
        throw new HelperError("NOT_BOUND", "No logged-in Qwen tab is available");
      },
      openDeepSeek: async () => undefined,
      openQwen: async (url: string) => {
        opened.push(url);
      },
      submitPrompt: async () => undefined,
      evaluate: async <T>() => undefined as T,
    } as never);

    await expect(
      client.bindProviderTab({ provider: "qwen-web", tabId: "tab-stale" }),
    ).rejects.toEqual(
      new HelperError("NOT_BOUND", "No browser tab is available for tab-stale"),
    );
    expect(opened).toEqual([]);
  });

  it("treats expected target navigation during startNewChat as success and reinjects the bridge", async () => {
    const evaluations: Array<{ tabId: string; script: string }> = [];
    let callCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(tabId: string, script: string) => {
        evaluations.push({ tabId, script });
        callCount += 1;

        if (callCount === 1) {
          throw new Error("Runtime.evaluate: Inspected target navigated or closed");
        }

        return undefined as T;
      },
    });

    await expect(client.startNewChat("tab-1")).resolves.toBeUndefined();
    expect(evaluations).toHaveLength(2);
    expect(evaluations[0]?.script).toContain("startNewChat()");
    expect(evaluations[1]?.script).toContain("__piDeepSeekBridge");
  });

  it("starts a Qwen new chat through provider-specific DOM actions", async () => {
    const evaluations: Array<{ tabId: string; script: string }> = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(tabId: string, script: string) => {
        evaluations.push({ tabId, script });
        return true as T;
      },
    });

    await expect(
      client.startNewChat({ provider: "qwen-web", tabId: "tab-qwen" }),
    ).resolves.toBeUndefined();
    expect(evaluations[0]?.tabId).toBe("tab-qwen");
    expect(evaluations[0]?.script).toContain("New Chat");
  });

  it("passes the DeepSeek target mode when starting a pro chat", async () => {
    const evaluations: Array<{ tabId: string; script: string }> = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(tabId: string, script: string) => {
        evaluations.push({ tabId, script });
        return { ok: true } as T;
      },
    });

    await expect(
      client.startNewChat({
        provider: "deepseek-web",
        tabId: "tab-1",
        modelId: "deepseek-web-pro",
      }),
    ).resolves.toBeUndefined();
    expect(evaluations[0]?.script).toContain('"targetModelType":"expert"');
  });

  it("reapplies the DeepSeek target mode after expected new-chat navigation", async () => {
    const evaluations: Array<{ tabId: string; script: string }> = [];
    let callCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(tabId: string, script: string) => {
        evaluations.push({ tabId, script });
        callCount += 1;

        if (callCount === 1) {
          throw new Error("Runtime.evaluate: Inspected target navigated or closed");
        }

        return { ok: true } as T;
      },
    });

    await expect(
      client.startNewChat({
        provider: "deepseek-web",
        tabId: "tab-1",
        modelId: "deepseek-web-pro",
      }),
    ).resolves.toBeUndefined();

    expect(evaluations).toHaveLength(3);
    expect(evaluations[0]?.script).toContain('startNewChat({"targetModelType":"expert"})');
    expect(evaluations[1]?.script).toContain("__piDeepSeekBridge");
    expect(evaluations[2]?.script).toContain('setModelType({"targetModelType":"expert"})');
  });

  it("translates page timeout responses into HelperError", async () => {
    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.getPageState()")) {
          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
          } as T;
        }

        return {
          inputReady: true,
          busy: false,
          latestAssistantPreview: null,
          assistantCount: 0,
        } as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "hello",
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "The page did not finish streaming in time",
      automationDebug: {
        source: "client_error",
        freshSession: false,
      },
    });
  });

  it("returns a completed Qwen reply from the latest assistant answer block", async () => {
    let pollCount = 0;
    const submitted: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async (_tabId: string, prompt: string) => {
        submitted.push(prompt);
      },
      evaluate: async <T>(_tabId: string, script: string) => {
        if (
          script.includes("__piQwenBridge.getPageState()") ||
          script.includes("qwen-chat-message-assistant")
        ) {
          if (script.includes("__piQwenBridge.getCompletionState()")) {
            pollCount += 1;
            if (pollCount === 1) {
              return {
                pageState: {
                  inputReady: true,
                  busy: true,
                  latestAssistantPreview: "",
                  assistantCount: 0,
                },
                completionState: {
                  observed: true,
                  status: "streaming",
                  closed: false,
                  turn: null,
                },
              } as T;
            }

            return {
              pageState: {
                inputReady: true,
                busy: false,
                latestAssistantPreview: "qwen",
                assistantCount: 1,
              },
              completionState: {
                observed: true,
                status: "finished",
                closed: true,
                turn: {
                  mode: "text",
                  outputText: "qwen",
                  thinkingText: "Thinking completed",
                },
              },
            } as T;
          }

          pollCount += 1;
          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "",
              assistantCount: 0,
              reply: "",
              thinking: "",
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "qwen",
            assistantCount: 1,
            reply: "qwen",
            thinking: "Thinking completed",
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        provider: "qwen-web",
        tabId: "tab-qwen",
        prompt: "reply with the single word qwen",
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({
      mode: "text",
      outputText: "qwen",
      thinkingText: "Thinking completed",
      modelLabel: "Qwen Web",
    });
    expect(submitted).toEqual(["reply with the single word qwen"]);
  });

  it("returns a structured Qwen tool call from completion SSE state", async () => {
    const submitted: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async (_tabId: string, prompt: string) => {
        submitted.push(prompt);
      },
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("__piQwenBridge.getPageState()")) {
          if (script.includes("__piQwenBridge.getCompletionState()")) {
            return {
              pageState: {
                inputReady: true,
                busy: false,
                latestAssistantPreview: "",
                assistantCount: 1,
              },
              completionState: {
                observed: true,
                status: "finished",
                closed: true,
                turn: {
                  mode: "native_tool_call",
                  toolCalls: [
                    {
                      name: "read",
                      argumentsJson: "{\"path\":\"src/app.ts\"}",
                    },
                  ],
                  thinkingText: "Inspecting the file request",
                  outputText: "",
                },
              },
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "",
            assistantCount: 0,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        provider: "qwen-web",
        tabId: "tab-qwen",
        prompt: "read src/app.ts",
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({
      mode: "native_tool_call",
      thinkingText: "Inspecting the file request",
      toolCalls: [
        {
          name: "read",
          argumentsJson: "{\"path\":\"src/app.ts\"}",
        },
      ],
      modelLabel: "Qwen Web",
    });
    expect(submitted).toEqual(["read src/app.ts"]);
  });

  it("returns a completed Qwen reply once the completion stream closes, even if status is idle", async () => {
    const submitted: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async (_tabId: string, prompt: string) => {
        submitted.push(prompt);
      },
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("__piQwenBridge.getPageState()")) {
          if (script.includes("__piQwenBridge.getCompletionState()")) {
            return {
              pageState: {
                inputReady: true,
                busy: false,
                latestAssistantPreview: "qwen from stream",
                assistantCount: 1,
              },
              completionState: {
                observed: true,
                status: "idle",
                closed: true,
                turn: {
                  mode: "text",
                  outputText: "qwen from stream",
                  thinkingText: "Thinking completed",
                },
              },
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "",
            assistantCount: 0,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        provider: "qwen-web",
        tabId: "tab-qwen",
        prompt: "reply with qwen from stream",
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({
      mode: "text",
      outputText: "qwen from stream",
      thinkingText: "Thinking completed",
      modelLabel: "Qwen Web",
    });
    expect(submitted).toEqual(["reply with qwen from stream"]);
  });

  it("does not return a stale finished Qwen completion from the previous turn", async () => {
    let pollCount = 0;
    let resetCount = 0;
    const submitted: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async (_tabId: string, prompt: string) => {
        submitted.push(prompt);
      },
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("__piQwenBridge.resetCompletionState()")) {
          resetCount += 1;
          return true as T;
        }

        if (script.includes("__piQwenBridge.getPageState()")) {
          if (script.includes("__piQwenBridge.getCompletionState()")) {
            pollCount += 1;

            if (pollCount === 1 && resetCount === 0) {
              return {
                pageState: {
                  inputReady: true,
                  busy: false,
                  latestAssistantPreview: "Hey there! How can I help you with your project today?",
                  assistantCount: 1,
                },
                completionState: {
                  observed: true,
                  status: "finished",
                  closed: true,
                  turn: {
                    mode: "text",
                    outputText: "Hey there! How can I help you with your project today?",
                  },
                },
              } as T;
            }

            if (pollCount === 2) {
              return {
                pageState: {
                  inputReady: true,
                  busy: true,
                  latestAssistantPreview: "Hey there! How can I help you with your project today?",
                  assistantCount: 2,
                },
                completionState: {
                  observed: true,
                  status: "streaming",
                  closed: false,
                  turn: null,
                },
              } as T;
            }

            return {
              pageState: {
                inputReady: true,
                busy: false,
                latestAssistantPreview: "I am Qwen.",
                assistantCount: 2,
              },
              completionState: {
                observed: true,
                status: "finished",
                closed: true,
                turn: {
                  mode: "text",
                  outputText: "I am Qwen.",
                },
              },
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "Hey there! How can I help you with your project today?",
            assistantCount: 1,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        provider: "qwen-web",
        tabId: "tab-qwen",
        prompt: "who are you",
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({
      mode: "text",
      outputText: "I am Qwen.",
      modelLabel: "Qwen Web",
    });
    expect(resetCount).toBe(1);
    expect(submitted).toEqual(["who are you"]);
  });

  it("waits for the Qwen completion stream to finish instead of timing out on the base timeout while streaming", async () => {
    let pollCount = 0;
    const submitted: string[] = [];

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async (_tabId: string, prompt: string) => {
        submitted.push(prompt);
      },
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("__piQwenBridge.getPageState()")) {
          if (script.includes("__piQwenBridge.getCompletionState()")) {
            pollCount += 1;

            if (pollCount < 3) {
              return {
                pageState: {
                  inputReady: true,
                  busy: true,
                  latestAssistantPreview: "",
                  assistantCount: 1,
                },
                completionState: {
                  observed: true,
                  status: "streaming",
                  closed: false,
                  turn: null,
                },
              } as T;
            }

            return {
              pageState: {
                inputReady: true,
                busy: false,
                latestAssistantPreview: "qwen after long stream",
                assistantCount: 1,
              },
              completionState: {
                observed: true,
                status: "finished",
                closed: true,
                turn: {
                  mode: "text",
                  outputText: "qwen after long stream",
                },
              },
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "",
            assistantCount: 0,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        provider: "qwen-web",
        tabId: "tab-qwen",
        prompt: "reply after a long stream",
        timeoutMs: 50,
      }),
    ).resolves.toMatchObject({
      mode: "text",
      outputText: "qwen after long stream",
      modelLabel: "Qwen Web",
    });
    expect(submitted).toEqual(["reply after a long stream"]);
    expect(pollCount).toBeGreaterThanOrEqual(3);
  });

  it("returns completion text and trace even when the completion body is an incomplete JSON prefix", async () => {
    const previousDebug = process.env.PI_DEEPSEEK_DEBUG;
    process.env.PI_DEEPSEEK_DEBUG = "1";

    try {
      const client = new BbBrowserClient({
        getConnectionStatus: async () => "connected",
        findDeepSeekTab: async () => ({
          id: "tab-1",
          url: "https://chat.deepseek.com/",
        }),
        openDeepSeek: async () => undefined,
        submitPrompt: async () => undefined,
        evaluate: async <T>(_tabId: string, script: string) => {
          if (script.includes("window.__piDeepSeekBridge.startPrompt(")) {
            return {
              ok: true,
              baselineState: {
                inputReady: true,
                busy: false,
                latestAssistantPreview: null,
                assistantCount: 0,
              },
            } as T;
          }

          if (script.includes("getCompletionState()") && script.includes("getPageState()")) {
            return {
              pageState: {
                inputReady: true,
                busy: false,
                latestAssistantPreview: null,
                assistantCount: 1,
              },
              completionState: {
                observed: true,
                status: "finished",
                closed: true,
                terminalAt: Date.now(),
                turn: {
                  mode: "text",
                  outputText: "{\"",
                },
              },
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 1,
          } as T;
        },
      });

      await expect(
        client.sendChatPrompt({
          tabId: "tab-1",
          prompt: "hello",
          timeoutMs: 50,
        }),
      ).resolves.toMatchObject({
        mode: "text",
        outputText: "{\"",
        debug: {
          source: "bridge_stream",
          freshSession: false,
          completionObserved: true,
          trace: expect.arrayContaining([
            expect.objectContaining({
              phase: "start_prompt",
            }),
            expect.objectContaining({
              phase: "poll",
              completionTurnPreview: "{\"",
            }),
          ]),
        },
      });
    } finally {
      if (previousDebug === undefined) {
        delete process.env.PI_DEEPSEEK_DEBUG;
      } else {
        process.env.PI_DEEPSEEK_DEBUG = previousDebug;
      }
    }
  });

  it("fails fast when DeepSeek shows a manual verification interstitial", async () => {
    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.getPageState()")) {
          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
            blockingMessage: "One more step before you proceed...",
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "hello",
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      code: "PAGE_UNAVAILABLE",
      message: "DeepSeek requires manual verification in the browser tab before chatting",
      automationDebug: {
        source: "client_error",
        freshSession: false,
      },
    });
  });

  it("uses the injected bridge stream result when available", async () => {
    let submittedPrompt: string | null = null;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async (_tabId: string, prompt: string) => {
        submittedPrompt = prompt;
      },
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.startPrompt(")) {
          return {
            ok: true,
            baselineState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
            },
          } as T;
        }

        if (script.includes("getCompletionState()") && script.includes("getPageState()")) {
          return {
            pageState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
            },
            completionState: {
              observed: true,
              status: "finished",
              closed: true,
              terminalAt: Date.now() - 1_000,
              turn: {
                mode: "text",
                outputText: "streamed reply",
              },
            },
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "hello",
        timeoutMs: 3000,
      }),
    ).resolves.toMatchObject({
      mode: "text",
      outputText: "streamed reply",
      debug: {
        source: "bridge_stream",
        freshSession: false,
      },
      modelLabel: "DeepSeek Web",
    });

    expect(submittedPrompt).toBeNull();
  });

  it("preserves thinking text from the injected bridge stream result", async () => {
    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.startPrompt(")) {
          return {
            ok: true,
            baselineState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
            },
          } as T;
        }

        if (script.includes("getCompletionState()") && script.includes("getPageState()")) {
          return {
            pageState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
            },
            completionState: {
              observed: true,
              status: "finished",
              closed: true,
              terminalAt: Date.now() - 1_000,
              turn: {
                mode: "text",
                thinkingText: "first think",
                outputText: "then answer",
              },
            },
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "hello",
        timeoutMs: 3000,
      }),
    ).resolves.toMatchObject({
      mode: "text",
      thinkingText: "first think",
      outputText: "then answer",
      modelLabel: "DeepSeek Web",
    });
  });

  it("includes bridge polling trace when PI_DEEPSEEK_DEBUG is enabled", async () => {
    const previousDebug = process.env.PI_DEEPSEEK_DEBUG;
    process.env.PI_DEEPSEEK_DEBUG = "1";

    try {
      const client = new BbBrowserClient({
        getConnectionStatus: async () => "connected",
        findDeepSeekTab: async () => ({
          id: "tab-1",
          url: "https://chat.deepseek.com/",
        }),
        openDeepSeek: async () => undefined,
        submitPrompt: async () => undefined,
        evaluate: async <T>(_tabId: string, script: string) => {
          if (script.includes("window.__piDeepSeekBridge.startPrompt(")) {
            return {
              ok: true,
              baselineState: {
                inputReady: true,
                busy: false,
                latestAssistantPreview: null,
                assistantCount: 0,
              },
            } as T;
          }

          if (script.includes("getCompletionState()") && script.includes("getPageState()")) {
            return {
              pageState: {
                inputReady: true,
                busy: false,
                latestAssistantPreview: null,
                assistantCount: 0,
              },
              completionState: {
                observed: true,
                status: "finished",
                closed: true,
                terminalAt: Date.now() - 1_000,
                turn: {
                  mode: "text",
                  outputText: "streamed reply",
                },
              },
            } as T;
          }

          return undefined as T;
        },
      });

      await expect(
        client.sendChatPrompt({
          tabId: "tab-1",
          prompt: "hello",
          timeoutMs: 3000,
        }),
      ).resolves.toMatchObject({
        mode: "text",
        outputText: "streamed reply",
        debug: {
          source: "bridge_stream",
          freshSession: false,
          completionObserved: true,
          trace: expect.arrayContaining([
            expect.objectContaining({
              phase: "start_prompt",
            }),
            expect.objectContaining({
              phase: "bridge_stream_text",
              completionTurnMode: "text",
            }),
          ]),
        },
      });
    } finally {
      if (previousDebug === undefined) {
        delete process.env.PI_DEEPSEEK_DEBUG;
      } else {
        process.env.PI_DEEPSEEK_DEBUG = previousDebug;
      }
    }
  });

  it("returns structured tool-call turns from the injected bridge", async () => {
    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.startPrompt(")) {
          return {
            ok: true,
            baselineState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
            },
          } as T;
        }

        if (script.includes("getCompletionState()") && script.includes("getPageState()")) {
          return {
            pageState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
            },
            completionState: {
              observed: true,
              status: "finished",
              closed: true,
              terminalAt: Date.now(),
              turn: {
                mode: "json_fallback",
                toolCalls: [
                  {
                    name: "read",
                    argumentsJson: "{\"path\":\"src/app.ts\"}",
                  },
                ],
                outputText:
                  "{\"type\":\"tool_call\",\"name\":\"read\",\"arguments\":{\"path\":\"src/app.ts\"}}",
              },
            },
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "read src/app.ts",
        timeoutMs: 3000,
      }),
    ).resolves.toMatchObject({
      mode: "json_fallback",
      toolCalls: [
        {
          name: "read",
          argumentsJson: "{\"path\":\"src/app.ts\"}",
        },
      ],
      outputText:
        "{\"type\":\"tool_call\",\"name\":\"read\",\"arguments\":{\"path\":\"src/app.ts\"}}",
      debug: {
        source: "bridge_stream",
        freshSession: false,
      },
      modelLabel: "DeepSeek Web",
    });
  });

  it("avoids long-lived bridge promises by starting the prompt and polling bridge state", async () => {
    let progressPollCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => {
        throw new Error("transport.submitPrompt should not be used when the bridge handles submission");
      },
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.sendPrompt(")) {
          throw new Error("Runtime.evaluate: Promise was collected");
        }

        if (script.includes("window.__piDeepSeekBridge.startPrompt(")) {
          return {
            ok: true,
            baselineState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "old reply",
              assistantCount: 1,
            },
          } as T;
        }

        if (script.includes("getCompletionState()") && script.includes("getPageState()")) {
          progressPollCount += 1;

          if (progressPollCount === 1) {
            return {
              pageState: {
                inputReady: true,
                busy: true,
                latestAssistantPreview: null,
                assistantCount: 1,
              },
              completionState: {
                observed: true,
                status: "streaming",
                closed: false,
                terminalAt: null,
                turn: null,
              },
            } as T;
          }

          return {
            pageState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "new reply",
              assistantCount: 2,
            },
            completionState: {
              observed: true,
              status: "finished",
              closed: true,
              terminalAt: Date.now(),
              turn: {
                mode: "text",
                outputText: "new reply",
              },
            },
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "hello again",
        timeoutMs: 3000,
      }),
    ).resolves.toMatchObject({
      mode: "text",
      outputText: "new reply",
      debug: {
        source: "bridge_stream",
        freshSession: false,
      },
      modelLabel: "DeepSeek Web",
    });
  });

  it("falls back to trusted transport submission when bridge start does not trigger a response", async () => {
    let submittedPrompt: string | null = null;
    let progressPollCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async (_tabId: string, prompt: string) => {
        submittedPrompt = prompt;
      },
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.startPrompt(")) {
          return {
            ok: false,
            error: "AUTOMATION_DESYNC",
            message: "Prompt submission did not start a DeepSeek response",
          } as T;
        }

        if (script.includes("getCompletionState()") && script.includes("getPageState()")) {
          progressPollCount += 1;

          if (progressPollCount === 1) {
            return {
              pageState: {
                inputReady: true,
                busy: true,
                latestAssistantPreview: null,
                assistantCount: 0,
              },
              completionState: {
                observed: false,
                status: "idle",
                closed: false,
                terminalAt: null,
                turn: null,
              },
            } as T;
          }

          return {
            pageState: {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "transport fallback reply",
              assistantCount: 1,
            },
            completionState: {
              observed: true,
              status: "finished",
              closed: true,
              terminalAt: Date.now(),
              turn: {
                mode: "text",
                outputText: "transport fallback reply",
              },
            },
          } as T;
        }

        if (script.includes("window.__piDeepSeekBridge.getPageState()")) {
          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: null,
            assistantCount: 0,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "hello via transport",
        timeoutMs: 3000,
      }),
    ).resolves.toMatchObject({
      mode: "text",
      outputText: "transport fallback reply",
      debug: {
        source: "bridge_stream",
        freshSession: false,
      },
      modelLabel: "DeepSeek Web",
    });

    expect(submittedPrompt).toBe("hello via transport");
  });

  it("times out when transport submission produces only DOM text without completion data", async () => {
    let submittedPrompt: string | null = null;
    let pollCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async (_tabId: string, prompt: string) => {
        submittedPrompt = prompt;
      },
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.getPageState()")) {
          pollCount += 1;
          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "old reply",
              assistantCount: 1,
            } as T;
          }

          if (pollCount === 2) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: "new reply",
              assistantCount: 2,
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "new reply",
            assistantCount: 2,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "hello",
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "The page did not finish streaming in time",
    });

    expect(submittedPrompt).toBe("hello");
  });

  it("does not return repeated DOM text without completion data", async () => {
    let pollCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.getPageState()")) {
          pollCount += 1;
          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "same reply",
              assistantCount: 1,
            } as T;
          }

          if (pollCount === 2) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: "same reply",
              assistantCount: 2,
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "same reply",
            assistantCount: 2,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "repeat",
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "The page did not finish streaming in time",
    });
  });

  it("does not treat DOM-only streaming text as a final reply", async () => {
    let pollCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.getPageState()")) {
          pollCount += 1;
          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "A",
              assistantCount: 1,
            } as T;
          }

          if (pollCount === 2) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: "AB",
              assistantCount: 2,
            } as T;
          }

          if (pollCount === 3) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: "ABC",
              assistantCount: 2,
            } as T;
          }

          if (pollCount === 4) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "ABC",
              assistantCount: 2,
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "ABC",
            assistantCount: 2,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "stream",
        timeoutMs: 400,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "The page did not finish streaming in time",
    });
  });

  it("does not return a first DOM token without completion data", async () => {
    let pollCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.getPageState()")) {
          pollCount += 1;
          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: null,
              assistantCount: 0,
            } as T;
          }

          if (pollCount <= 4) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: null,
              assistantCount: 0,
            } as T;
          }

          if (pollCount === 5) {
            return {
              inputReady: true,
              busy: true,
              latestAssistantPreview: "first token",
              assistantCount: 1,
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "first token",
            assistantCount: 1,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "busy-first-token",
        timeoutMs: 400,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "The page did not finish streaming in time",
    });
  });

  it("does not recover final text from DOM after timeout when completion data is absent", async () => {
    let pollCount = 0;
    let resetCount = 0;

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge = undefined")) {
          resetCount += 1;
          return true as T;
        }

        if (script.includes("window.__piDeepSeekBridge.getPageState()")) {
          pollCount += 1;

          if (pollCount === 1) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "old reply",
              assistantCount: 1,
            } as T;
          }

          if (resetCount > 0) {
            return {
              inputReady: true,
              busy: false,
              latestAssistantPreview: "new reply",
              assistantCount: 2,
            } as T;
          }

          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: "old reply",
            assistantCount: 1,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "recover",
        timeoutMs: 400,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "The page did not finish streaming in time",
    });

    expect(resetCount).toBe(1);
  });

  it("does not use fresh-session DOM text when completion data never arrives", async () => {
    let currentReply: string | null = null;

    setTimeout(() => {
      currentReply = "I'm";
    }, 100);

    setTimeout(() => {
      currentReply = "I'm here to help with your task.";
    }, 2_000);

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async () => undefined,
      submitPrompt: async () => undefined,
      evaluate: async <T>(_tabId: string, script: string) => {
        if (script.includes("window.__piDeepSeekBridge.getPageState()")) {
          return {
            inputReady: true,
            busy: false,
            latestAssistantPreview: currentReply,
            assistantCount: currentReply ? 1 : 0,
          } as T;
        }

        return undefined as T;
      },
    });

    await expect(
      client.sendChatPrompt({
        tabId: "tab-1",
        prompt: "hello",
        timeoutMs: 4_000,
        freshSession: true,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "The page did not finish streaming in time",
    });
  });
});

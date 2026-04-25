import { describe, expect, it } from "vitest";
import { HelperError } from "../src/errors";
import {
  BbBrowserClient,
  extractTabsFromTabList,
  unwrapEvalResult,
} from "../src/browser/bb-browser-client";

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
      },
    });
    expect(evaluations).toHaveLength(1);
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
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.tabId).toBe("tab-deepseek");
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

  it("polls findDeepSeekTab after opening page until tab appears", async () => {
    const opened: string[] = [];
    let findAttempts = 0;

    const client = new BbBrowserClient(
      {
        getConnectionStatus: async () => "connected",
        findDeepSeekTab: async () => {
          findAttempts++;
          if (findAttempts <= 3) {
            throw new Error("No page target found");
          }
          return { id: "tab-ds", url: "https://chat.deepseek.com/" };
        },
        openDeepSeek: async (url: string) => {
          opened.push(url);
        },
        submitPrompt: async () => undefined,
        evaluate: async <T>() => undefined as T,
      },
      { maxWaitMs: 500, retryIntervalMs: 50 },
    );

    const result = await client.bindDeepSeekTab();
    expect(result.tabId).toBe("tab-ds");
    expect(opened).toEqual(["https://chat.deepseek.com"]);
  });

  it("succeeds when tab appears after NOT_BOUND retries", async () => {
    const opened: string[] = [];
    let findAttempts = 0;

    const client = new BbBrowserClient(
      {
        getConnectionStatus: async () => "connected",
        findDeepSeekTab: async () => {
          findAttempts++;
          if (findAttempts <= 3) {
            throw new HelperError("NOT_BOUND", "No logged-in DeepSeek tab is available");
          }
          return { id: "tab-ds", url: "https://chat.deepseek.com/" };
        },
        openDeepSeek: async (url: string) => {
          opened.push(url);
        },
        submitPrompt: async () => undefined,
        evaluate: async <T>() => undefined as T,
      },
      { maxWaitMs: 500, retryIntervalMs: 50 },
    );

    const result = await client.bindDeepSeekTab();
    expect(result.tabId).toBe("tab-ds");
    expect(opened).toEqual(["https://chat.deepseek.com"]);
  });

  it("throws NOT_BOUND when tab never appears within timeout", async () => {
    const client = new BbBrowserClient(
      {
        getConnectionStatus: async () => "connected",
        findDeepSeekTab: async () => {
          throw new Error("No page target found");
        },
        openDeepSeek: async () => undefined,
        submitPrompt: async () => undefined,
        evaluate: async <T>() => undefined as T,
      },
      { maxWaitMs: 200, retryIntervalMs: 50 },
    );

    await expect(client.bindDeepSeekTab()).rejects.toMatchObject({
      code: "NOT_BOUND",
    });
  });

  it("throws immediately for unknown errors", async () => {
    const client = new BbBrowserClient(
      {
        getConnectionStatus: async () => "connected",
        findDeepSeekTab: async () => {
          throw new Error("Something unexpected happened");
        },
        openDeepSeek: async () => undefined,
        submitPrompt: async () => undefined,
        evaluate: async <T>() => undefined as T,
      },
      { maxWaitMs: 200, retryIntervalMs: 50 },
    );

    await expect(client.bindDeepSeekTab()).rejects.toThrow("Something unexpected happened");
  });

  it("opens a new tab and injects bridge with initModes for startNewChat", async () => {
    const evaluations: Array<{ tabId: string; script: string }> = [];
    const newTabId = "tab-fresh-1";

    const client = new BbBrowserClient({
      getConnectionStatus: async () => "connected",
      findDeepSeekTab: async () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
      }),
      openDeepSeek: async (url: string) => ({
        tabId: newTabId,
        url,
      }),
      submitPrompt: async () => undefined,
      evaluate: async <T>(tabId: string, script: string) => {
        evaluations.push({ tabId, script });
        return undefined as T;
      },
    });

    const result = await client.startNewChat("tab-1");
    expect(result).toEqual({ tabId: newTabId });
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.tabId).toBe(newTabId);
    expect(evaluations[0]?.script).toContain("initModes()");
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
                  toolCall: {
                    name: "read",
                    argumentsJson: "{\"path\":\"src/app.ts\"}",
                  },
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
      toolCall: {
        name: "read",
        argumentsJson: "{\"path\":\"src/app.ts\"}",
      },
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
                toolCall: {
                  name: "read",
                  argumentsJson: "{\"path\":\"src/app.ts\"}",
                },
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
      toolCall: {
        name: "read",
        argumentsJson: "{\"path\":\"src/app.ts\"}",
      },
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

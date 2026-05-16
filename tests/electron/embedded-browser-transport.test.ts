import { describe, expect, it } from "vitest";
import { createEmbeddedBrowserTransport } from "../../electron/embedded-browser-transport";

describe("embedded browser transport", () => {
  it("returns the last expression value from evaluated scripts", async () => {
    const transport = createEmbeddedBrowserTransport({
      getTabById: () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
        webContents: {
          executeJavaScript: async (code: string) => eval(code),
        } as never,
      }),
      listTabs: () => [],
      getActiveTab: () => null,
      createTab: async () => {
        throw new Error("not needed");
      },
    });

    const result = await transport.evaluate<{ ok: number }>(
      "tab-1",
      "const value = 7; ({ ok: value })",
    );

    expect(result).toEqual({ ok: 7 });
  });

  it("times out stalled executeJavaScript calls", async () => {
    const transport = createEmbeddedBrowserTransport({
      getTabById: () => ({
        id: "tab-1",
        url: "https://chat.deepseek.com/",
        webContents: {
          executeJavaScript: async () => await new Promise(() => {}),
        } as never,
      }),
      listTabs: () => [],
      getActiveTab: () => null,
      createTab: async () => {
        throw new Error("not needed");
      },
      executeTimeoutMs: 10,
    });

    await expect(
      transport.evaluate("tab-1", "42"),
    ).rejects.toThrow("Embedded browser evaluate timed out after 10ms on tab-1");
  });
});

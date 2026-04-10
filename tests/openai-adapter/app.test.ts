import { describe, expect, it, vi } from "vitest";
import { createHelperClient } from "../../src/openai-adapter/helper-client";

describe("openai adapter helper client", () => {
  it("maps normalized requests into helper provider chat payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: "text",
        outputText: "helper says hi",
        finishReason: "stop",
      }),
    });

    const client = createHelperClient({
      helperBaseUrl: "http://127.0.0.1:4318",
      helperToken: "helper-token",
      fetchImpl: fetchMock,
    });

    const result = await client.run({
      publicModel: "qwen-web-chat",
      provider: "qwen-web",
      responseFormat: "chat_completions",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/v1/provider/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer helper-token",
        }),
        body: JSON.stringify({
          provider: "qwen-web",
          model: "qwen-web-chat",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );
    expect(result).toMatchObject({
      mode: "text",
      outputText: "helper says hi",
    });
  });
});

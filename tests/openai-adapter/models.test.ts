import { describe, expect, it } from "vitest";
import {
  getPublicModel,
  listPublicModels,
} from "../../src/openai-adapter/models";

describe("openai adapter model registry", () => {
  it("lists stable public models", () => {
    expect(listPublicModels()).toEqual([
      expect.objectContaining({
        id: "deepseek-web-pro",
        provider: "deepseek-web",
        supportsTools: true,
      }),
      expect.objectContaining({
        id: "deepseek-web-flash",
        provider: "deepseek-web",
        supportsTools: true,
      }),
      expect.objectContaining({
        id: "qwen-web-chat",
        provider: "qwen-web",
        supportsTools: false,
      }),
      expect.objectContaining({
        id: "qwen-web-tools",
        provider: "qwen-web",
        supportsTools: true,
      }),
    ]);
  });

  it("returns a model by public id", () => {
    expect(getPublicModel("deepseek-web-chat")).toMatchObject({
      id: "deepseek-web-chat",
      provider: "deepseek-web",
      supportsTools: true,
      listed: false,
    });
    expect(getPublicModel("qwen-web-tools")).toMatchObject({
      id: "qwen-web-tools",
      provider: "qwen-web",
      supportsTools: true,
      defaultTimeoutMs: 30000,
    });
  });

  it("returns null for an unknown model", () => {
    expect(getPublicModel("missing-model")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeGuide,
  createDesktopConfig,
  mergeDesktopSettings,
} from "../../src/shared/desktop-config";

describe("desktop-config", () => {
  it("creates defaults with distinct ports and generated tokens", () => {
    const config = createDesktopConfig();

    expect(config.helperPort).toBe(4318);
    expect(config.gatewayPort).toBe(4321);
    expect(config.gatewayToken).toMatch(/^gateway-/);
    expect(config.helperToken).toMatch(/^helper-/);
  });

  it("rejects duplicate helper and gateway ports", () => {
    expect(() =>
      mergeDesktopSettings(createDesktopConfig(), {
        helperPort: 4400,
        gatewayPort: 4400,
      }),
    ).toThrow("Helper port and gateway port must be different.");
  });

  it("builds claude code guide values from the current config", () => {
    const guide = buildClaudeCodeGuide({
      helperPort: 4318,
      gatewayPort: 5321,
      gatewayToken: "desktop-token",
    });

    expect(guide.protocol).toBe("Anthropic");
    expect(guide.baseUrl).toBe("http://127.0.0.1:5321");
    expect(guide.apiKey).toBe("desktop-token");
    expect(guide.models).toContain("deepseek-web-pro");
  });
});

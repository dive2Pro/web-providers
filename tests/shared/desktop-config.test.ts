import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeLaunchConfig,
  buildClaudeCodeGuide,
  buildClaudeCodeStartupCommand,
  createDesktopConfig,
  mergeDesktopSettings,
} from "../../src/shared/desktop-config";

describe("desktop-config", () => {
  it("creates defaults with generated tokens", () => {
    const config = createDesktopConfig();

    expect(config.gatewayToken).toMatch(/^gateway-/);
    expect(config.helperToken).toMatch(/^helper-/);
  });

  it("merges gateway token updates", () => {
    const current = createDesktopConfig();

    expect(
      mergeDesktopSettings(current, {
        gatewayToken: "desktop-token",
      }).gatewayToken,
    ).toBe("desktop-token");
  });

  it("builds claude code guide values from the current config", () => {
    const guide = buildClaudeCodeGuide({
      gatewayUrl: "http://127.0.0.1:5321",
      gatewayToken: "desktop-token",
    });

    expect(guide.protocol).toBe("Anthropic");
    expect(guide.baseUrl).toBe("http://127.0.0.1:5321");
    expect(guide.apiKey).toBe("desktop-token");
    expect(guide.models).toContain("deepseek-web-pro");
  });

  it("builds launch env for claude code", () => {
    const launchConfig = buildClaudeCodeLaunchConfig({
      claudeConfigDir: "$PWD/.claude-web-providers",
      gatewayUrl: "http://127.0.0.1:5321",
      gatewayToken: "desktop-token",
      modelId: "qwen-web-tools",
    });

    expect(launchConfig.CLAUDE_CONFIG_DIR).toBe("$PWD/.claude-web-providers");
    expect(launchConfig.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:5321");
    expect(launchConfig.ANTHROPIC_AUTH_TOKEN).toBe("desktop-token");
    expect(launchConfig.ANTHROPIC_MODEL).toBe("qwen-web-tools");
    expect(launchConfig.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("qwen-web-tools");
    expect(launchConfig.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("qwen-web-tools");
    expect(launchConfig.CLAUDE_CODE_SUBAGENT_MODEL).toBe("qwen-web-tools");
  });

  it("builds a copyable claude startup command", () => {
    const command = buildClaudeCodeStartupCommand({
      CLAUDE_CONFIG_DIR: "$PWD/.claude-web-providers",
      ANTHROPIC_AUTH_TOKEN: "desktop-token",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:5321",
      ANTHROPIC_MODEL: "deepseek-web-pro",
    });

    expect(command).toContain("env \\");
    expect(command).toContain('CLAUDE_CONFIG_DIR="$PWD/.claude-web-providers" \\');
    expect(command).toContain("ANTHROPIC_AUTH_TOKEN='desktop-token' \\");
    expect(command).toContain("ANTHROPIC_BASE_URL='http://127.0.0.1:5321' \\");
    expect(command).toContain("  claude --model 'deepseek-web-pro'");
  });
});

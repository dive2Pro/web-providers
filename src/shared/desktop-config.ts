import { randomBytes } from "node:crypto";
import { listPublicModels } from "../openai-adapter/models";

export const DEFAULT_HELPER_PORT = 4318;
export const DEFAULT_GATEWAY_PORT = 4321;
const DEFAULT_CLAUDE_CODE_MODEL = "deepseek-web-pro";
const DEFAULT_CLAUDE_CODE_FAST_MODEL = "deepseek-web-flash";

export type DesktopConfig = {
  gatewayToken: string;
  helperToken: string;
};

export type DesktopPublicConfig = Pick<DesktopConfig, "gatewayToken">;

export type DesktopSettingsInput = Partial<DesktopPublicConfig>;

export type ClaudeCodeGuide = {
  protocol: "Anthropic";
  baseUrl: string;
  apiKey: string;
  models: string[];
  steps: string[];
};

export type ClaudeCodeLaunchConfig = {
  CLAUDE_CONFIG_DIR: string;
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL: string;
  CLAUDE_CODE_SUBAGENT_MODEL: string;
  ANTHROPIC_MODEL: string;
};

export type ShellCommandFormat = "multiline";

export function createDesktopConfig(
  input?: Partial<DesktopConfig>,
): DesktopConfig {
  return {
    gatewayToken: normalizeToken(input?.gatewayToken, createSecret("gateway")),
    helperToken: normalizeToken(input?.helperToken, createSecret("helper")),
  };
}

export function deserializeDesktopConfig(raw: unknown): DesktopConfig {
  if (!raw || typeof raw !== "object") {
    return createDesktopConfig();
  }

  return createDesktopConfig(raw as Partial<DesktopConfig>);
}

export function mergeDesktopSettings(
  current: DesktopConfig,
  input: DesktopSettingsInput,
): DesktopConfig {
  return {
    ...current,
    gatewayToken:
      input.gatewayToken === undefined
        ? current.gatewayToken
        : normalizeStrictToken(input.gatewayToken, "Gateway token"),
  };
}

export function toPublicDesktopConfig(
  config: DesktopConfig,
): DesktopPublicConfig {
  return {
    gatewayToken: config.gatewayToken,
  };
}

export function buildClaudeCodeGuide(
  input: {
    gatewayUrl: string;
    gatewayToken: string;
  },
): ClaudeCodeGuide {
  return {
    protocol: "Anthropic",
    baseUrl: input.gatewayUrl,
    apiKey: input.gatewayToken,
    models: listPublicModels().map((model) => model.id),
    steps: [
      "Start Web Providers Desktop and keep the service status green.",
      "Choose a model next to `Copy Claude Command`.",
      "Click `Copy Claude Command` and paste the command into your terminal.",
      "The copied command maps all Claude Code modes to the selected model.",
      "If you configure Claude Code manually, use the Protocol / Base URL / API Key shown here.",
    ],
  };
}

export function buildClaudeCodeLaunchConfig(input: {
  claudeConfigDir: string;
  gatewayUrl: string;
  gatewayToken: string;
  modelId: string;
}): ClaudeCodeLaunchConfig {
  const modelId = normalizeClaudeCodeModel(input.modelId, DEFAULT_CLAUDE_CODE_MODEL);

  return {
    CLAUDE_CONFIG_DIR: input.claudeConfigDir,
    ANTHROPIC_AUTH_TOKEN: input.gatewayToken,
    ANTHROPIC_BASE_URL: input.gatewayUrl,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
    CLAUDE_CODE_SUBAGENT_MODEL: modelId,
    ANTHROPIC_MODEL: modelId,
  };
}

export function buildClaudeCodeStartupCommand(
  env: Record<string, string>,
  format: ShellCommandFormat = "multiline",
) {
  const model = env.ANTHROPIC_MODEL ?? DEFAULT_CLAUDE_CODE_MODEL;

  if (format === "multiline") {
    const assignments = Object.entries(env).map(
      ([key, value]) => `  ${key}=${quoteShellValueForCommand(key, value)} \\`,
    );

    return [
      "env \\",
      ...assignments,
      `  claude --model ${quoteShellValue(model)}`,
    ].join("\n");
  }

  return `claude --model ${quoteShellValue(model)}`;
}

function createSecret(prefix: string) {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

function normalizeToken(value: unknown, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeStrictToken(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function normalizeClaudeCodeModel(value: unknown, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  return listPublicModels().some((model) => model.id === trimmed) ? trimmed : fallback;
}

function quoteShellValue(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function quoteShellValueForCommand(key: string, value: string) {
  if (key === "CLAUDE_CONFIG_DIR" && value.includes("$PWD")) {
    return `"${value.replace(/["\\`]/g, "\\$&")}"`;
  }

  return quoteShellValue(value);
}

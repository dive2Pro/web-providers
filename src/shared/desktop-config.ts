import { randomBytes } from "node:crypto";
import { listPublicModels } from "../openai-adapter/models";

export const DEFAULT_HELPER_PORT = 4318;
export const DEFAULT_GATEWAY_PORT = 4321;

export type DesktopConfig = {
  helperPort: number;
  gatewayPort: number;
  gatewayToken: string;
  helperToken: string;
};

export type DesktopPublicConfig = Pick<
  DesktopConfig,
  "helperPort" | "gatewayPort" | "gatewayToken"
>;

export type DesktopSettingsInput = Partial<DesktopPublicConfig>;

export type ClaudeCodeGuide = {
  protocol: "Anthropic";
  baseUrl: string;
  apiKey: string;
  models: string[];
  steps: string[];
};

export function createDesktopConfig(
  input?: Partial<DesktopConfig>,
): DesktopConfig {
  const config: DesktopConfig = {
    helperPort: normalizePort(input?.helperPort, DEFAULT_HELPER_PORT),
    gatewayPort: normalizePort(input?.gatewayPort, DEFAULT_GATEWAY_PORT),
    gatewayToken: normalizeToken(input?.gatewayToken, createSecret("gateway")),
    helperToken: normalizeToken(input?.helperToken, createSecret("helper")),
  };

  assertDistinctPorts(config);
  return config;
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
  const next: DesktopConfig = {
    ...current,
    helperPort:
      input.helperPort === undefined
        ? current.helperPort
        : normalizeStrictPort(input.helperPort, "Helper port"),
    gatewayPort:
      input.gatewayPort === undefined
        ? current.gatewayPort
        : normalizeStrictPort(input.gatewayPort, "Gateway port"),
    gatewayToken:
      input.gatewayToken === undefined
        ? current.gatewayToken
        : normalizeStrictToken(input.gatewayToken, "Gateway token"),
  };

  assertDistinctPorts(next);
  return next;
}

export function toPublicDesktopConfig(
  config: DesktopConfig,
): DesktopPublicConfig {
  return {
    helperPort: config.helperPort,
    gatewayPort: config.gatewayPort,
    gatewayToken: config.gatewayToken,
  };
}

export function buildClaudeCodeGuide(
  config: DesktopPublicConfig,
): ClaudeCodeGuide {
  const baseUrl = `http://127.0.0.1:${config.gatewayPort}`;

  return {
    protocol: "Anthropic",
    baseUrl,
    apiKey: config.gatewayToken,
    models: listPublicModels().map((model) => model.id),
    steps: [
      "Start Web Providers Desktop and keep the service status green.",
      "In `cc switch`, set Protocol to `Anthropic`.",
      `Set Base URL to \`${baseUrl}\`.`,
      "Set API Key to the gateway token shown in the desktop app.",
    ],
  };
}

function createSecret(prefix: string) {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

function normalizePort(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }

  return fallback;
}

function normalizeStrictPort(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }

  return parsed;
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

function assertDistinctPorts(config: Pick<DesktopConfig, "helperPort" | "gatewayPort">) {
  if (config.helperPort === config.gatewayPort) {
    throw new Error("Helper port and gateway port must be different.");
  }
}

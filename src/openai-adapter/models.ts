export type ProviderId = "deepseek-web" | "qwen-web";

export type PublicModel = {
  id: string;
  provider: ProviderId;
  supportsTools: boolean;
  defaultTimeoutMs: number;
  allowThinkingText: boolean;
  sessionMode: "reuse-bound-session";
};

const PUBLIC_MODELS: PublicModel[] = [
  {
    id: "deepseek-web-chat",
    provider: "deepseek-web",
    supportsTools: false,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
  },
  {
    id: "deepseek-web-tools",
    provider: "deepseek-web",
    supportsTools: true,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
  },
  {
    id: "qwen-web-chat",
    provider: "qwen-web",
    supportsTools: false,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
  },
  {
    id: "qwen-web-tools",
    provider: "qwen-web",
    supportsTools: true,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
  },
];

export function listPublicModels() {
  return [...PUBLIC_MODELS];
}

export function getPublicModel(modelId: string) {
  return PUBLIC_MODELS.find((model) => model.id === modelId) ?? null;
}

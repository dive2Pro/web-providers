export type ProviderId = "deepseek-web" | "qwen-web";
export type DeepSeekPageMode = "expert" | "default";

export type PublicModel = {
  id: string;
  provider: ProviderId;
  supportsTools: boolean;
  defaultTimeoutMs: number;
  allowThinkingText: boolean;
  sessionMode: "reuse-bound-session";
  listed: boolean;
  deepSeekPageMode?: DeepSeekPageMode;
};

const PUBLIC_MODELS: PublicModel[] = [
  {
    id: "deepseek-web-pro",
    provider: "deepseek-web",
    supportsTools: true,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
    listed: true,
    deepSeekPageMode: "expert",
  },
  {
    id: "deepseek-web-flash",
    provider: "deepseek-web",
    supportsTools: true,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
    listed: true,
    deepSeekPageMode: "default",
  },
  {
    id: "deepseek-web-chat",
    provider: "deepseek-web",
    supportsTools: true,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
    listed: false,
    deepSeekPageMode: "expert",
  },
  {
    id: "deepseek-web-tools",
    provider: "deepseek-web",
    supportsTools: true,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
    listed: false,
    deepSeekPageMode: "expert",
  },
  {
    id: "qwen-web-chat",
    provider: "qwen-web",
    supportsTools: false,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
    listed: true,
  },
  {
    id: "qwen-web-tools",
    provider: "qwen-web",
    supportsTools: true,
    defaultTimeoutMs: 30000,
    allowThinkingText: true,
    sessionMode: "reuse-bound-session",
    listed: true,
  },
];

export function listPublicModels() {
  return PUBLIC_MODELS.filter((model) => model.listed);
}

export function getPublicModel(modelId: string) {
  return PUBLIC_MODELS.find((model) => model.id === modelId) ?? null;
}

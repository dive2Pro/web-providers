export type AnthropicAdapterConfig = {
  token?: string;
  helperBaseUrl: string;
  helperToken?: string;
  port: number;
};

export function loadAnthropicAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): AnthropicAdapterConfig {
  return {
    token: env.ANTHROPIC_ADAPTER_TOKEN,
    helperBaseUrl: env.HELPER_BASE_URL ?? "http://127.0.0.1:4318",
    helperToken: env.HELPER_TOKEN,
    port: Number(env.PORT ?? 4320),
  };
}

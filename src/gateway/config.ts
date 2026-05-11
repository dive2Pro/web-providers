export type GatewayConfig = {
  openAiToken?: string;
  anthropicToken?: string;
  helperBaseUrl: string;
  helperToken?: string;
  port: number;
};

export function loadGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const sharedToken = env.GATEWAY_TOKEN;

  return {
    openAiToken: env.OPENAI_ADAPTER_TOKEN ?? sharedToken,
    anthropicToken: env.ANTHROPIC_ADAPTER_TOKEN ?? sharedToken,
    helperBaseUrl: env.HELPER_BASE_URL ?? "http://127.0.0.1:4318",
    helperToken: env.HELPER_TOKEN,
    port: Number(env.PORT ?? 4321),
  };
}

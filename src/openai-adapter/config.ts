export type OpenAiAdapterConfig = {
  token?: string;
  helperBaseUrl: string;
  helperToken?: string;
  port: number;
};

export function loadOpenAiAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenAiAdapterConfig {
  const token = env.OPENAI_ADAPTER_TOKEN;
  const helperBaseUrl = env.HELPER_BASE_URL;
  const helperToken = env.HELPER_TOKEN;

  if (!helperBaseUrl) {
    throw new Error("HELPER_BASE_URL is required");
  }

  return {
    token,
    helperBaseUrl,
    helperToken,
    port: Number(env.PORT ?? 4319),
  };
}

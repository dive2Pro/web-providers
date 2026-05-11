import { buildOpenAiAdapterApp } from "./app";
import { loadOpenAiAdapterConfig } from "./config";

const config = loadOpenAiAdapterConfig();

const app = buildOpenAiAdapterApp({
  token: config.token,
  helperBaseUrl: config.helperBaseUrl,
  helperToken: config.helperToken,
});

const address = await app.listen({
  host: "127.0.0.1",
  port: config.port,
});

console.log(`[openai-adapter] listening on ${address}`);
console.log(
  `[openai-adapter] endpoints: ${address}/v1/models ${address}/v1/chat/completions ${address}/v1/responses`,
);

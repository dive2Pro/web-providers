import { buildAnthropicAdapterApp } from "./app";
import { loadAnthropicAdapterConfig } from "./config";

const config = loadAnthropicAdapterConfig();

const app = buildAnthropicAdapterApp({
  token: config.token,
  helperBaseUrl: config.helperBaseUrl,
  helperToken: config.helperToken,
});

const address = await app.listen({
  host: "127.0.0.1",
  port: config.port,
});

console.log(`[anthropic-adapter] listening on ${address}`);
console.log(
  `[anthropic-adapter] endpoints: ${address}/v1/models ${address}/v1/messages ${address}/v1/messages/count_tokens`,
);

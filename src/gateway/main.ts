import { buildGatewayApp } from "./app";
import { loadGatewayConfig } from "./config";

const config = loadGatewayConfig();

const app = buildGatewayApp({
  openAiToken: config.openAiToken,
  anthropicToken: config.anthropicToken,
  helperBaseUrl: config.helperBaseUrl,
  helperToken: config.helperToken,
});

const address = await app.listen({
  host: "127.0.0.1",
  port: config.port,
});

console.log(`[gateway] listening on ${address}`);
console.log(
  `[gateway] endpoints: ${address}/v1/models ${address}/v1/chat/completions ${address}/v1/responses ${address}/v1/messages`,
);

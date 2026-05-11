import { buildAnthropicAdapterApp } from "./app";
import { loadAnthropicAdapterConfig } from "./config";

const config = loadAnthropicAdapterConfig();

const app = buildAnthropicAdapterApp({
  token: config.token,
  helperBaseUrl: config.helperBaseUrl,
  helperToken: config.helperToken,
});

await app.listen({
  host: "127.0.0.1",
  port: config.port,
});

import { buildOpenAiAdapterApp } from "./app";
import { loadOpenAiAdapterConfig } from "./config";

const config = loadOpenAiAdapterConfig();

const app = buildOpenAiAdapterApp({
  token: config.token,
  helperBaseUrl: config.helperBaseUrl,
  helperToken: config.helperToken,
});

await app.listen({
  host: "127.0.0.1",
  port: config.port,
});

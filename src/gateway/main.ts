import { buildGatewayApp } from "./app";
import { loadGatewayConfig } from "./config";
import { getDefaultRequestLogDir } from "../shared/request-log-store";
import { logServiceStarted } from "../shared/startup-log";

const config = loadGatewayConfig();

const app = buildGatewayApp({
  openAiToken: config.openAiToken,
  anthropicToken: config.anthropicToken,
  helperBaseUrl: config.helperBaseUrl,
  helperToken: config.helperToken,
  requestLogDir: process.env.REQUEST_LOG_DIR ?? getDefaultRequestLogDir(),
});

const address = await app.listen({
  host: "127.0.0.1",
  port: config.port,
});

logServiceStarted("gateway", address);

import { buildApp } from "./app";
import { BbBrowserClient, createBbBrowserTransport } from "./browser/bb-browser-client";
import { getDefaultRequestLogDir } from "../shared/request-log-store";

const token = process.env.HELPER_TOKEN;

const app = buildApp({
  token,
  browserClient: new BbBrowserClient(createBbBrowserTransport()),
  requestLogDir: process.env.REQUEST_LOG_DIR ?? getDefaultRequestLogDir(),
});

const address = await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 4318),
});

console.log(`[helper] listening on ${address}`);
console.log(`[helper] endpoints: ${address}/v1/health ${address}/v1/chat ${address}/v1/provider/chat`);

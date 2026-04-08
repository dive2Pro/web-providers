import { buildApp } from "./app";
import { BbBrowserClient, createBbBrowserTransport } from "./browser/bb-browser-client";

const token = process.env.HELPER_TOKEN;

if (!token) {
  throw new Error("HELPER_TOKEN is required");
}

const app = buildApp({
  token,
  browserClient: new BbBrowserClient(createBbBrowserTransport()),
});

await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 4318),
});

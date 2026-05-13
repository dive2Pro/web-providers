import { buildApp } from "./app";
import { BbBrowserClient, createBbBrowserTransport } from "./browser/bb-browser-client";
import { getDefaultSessionBindingDir } from "./session-binding-store";
import { getDefaultRequestLogDir } from "../shared/request-log-store";
import { logServiceStarted } from "../shared/startup-log";

const token = process.env.HELPER_TOKEN;

const app = buildApp({
  token,
  browserClient: new BbBrowserClient(createBbBrowserTransport()),
  requestLogDir: process.env.REQUEST_LOG_DIR ?? getDefaultRequestLogDir(),
  sessionBindingDir:
    process.env.SESSION_BINDING_DIR ?? getDefaultSessionBindingDir(),
});

const address = await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 4318),
});

logServiceStarted("helper", address);

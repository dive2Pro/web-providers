import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RequestLogStore } from "./request-log-store";

export interface RequestLogEntry {
  scope: string;
  requestId: string;
  method: string;
  url: string;
  routePath: string | null;
  statusCode: number;
  durationMs: number;
  headers: Record<string, unknown>;
  body: unknown;
}

export type RequestLogger = (entry: RequestLogEntry) => void;

export function registerRequestLogging(
  app: FastifyInstance,
  input: {
    scope: string;
    logger?: RequestLogger;
    store?: RequestLogStore;
  },
) {
  const requestLogger = input.logger;
  const startedAtByRequest = new WeakMap<FastifyRequest, number>();

  app.addHook("onRequest", async (request) => {
    startedAtByRequest.set(request, Date.now());
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const startedAt = startedAtByRequest.get(request) ?? Date.now();
    const routePath =
      typeof request.routeOptions.url === "string" ? request.routeOptions.url : null;

    const entry = {
      scope: input.scope,
      requestId: request.id,
      method: request.method,
      url: request.url,
      routePath,
      statusCode: reply.statusCode,
      durationMs: Date.now() - startedAt,
      headers: { ...request.headers },
      body: request.body,
    } satisfies RequestLogEntry;

    requestLogger?.(entry);

    if (input.store) {
      await input.store.append(entry);
    }

    return payload;
  });
}

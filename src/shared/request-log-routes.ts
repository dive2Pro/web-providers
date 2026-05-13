import type { FastifyInstance } from "fastify";
import type { RequestLogStore } from "./request-log-store";

export function registerRequestLogRoutes(
  app: FastifyInstance,
  input: {
    scope: string;
    store: RequestLogStore;
  },
) {
  app.get("/v1/debug/request-logs", async (request, reply) => {
    const query = (request.query ?? {}) as { limit?: string | number };
    const limit = parseLimit(query.limit);

    if (limit === null) {
      return reply.code(400).send({
        error: "INVALID_LIMIT",
        message: "limit must be a positive integer",
      });
    }

    const result = await input.store.list({ limit });
    return {
      scope: input.scope,
      filePath: result.filePath,
      logs: result.logs,
    };
  });
}

function parseLimit(limit: string | number | undefined) {
  if (limit === undefined) {
    return undefined;
  }

  const parsed =
    typeof limit === "number" ? limit : Number.parseInt(limit, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

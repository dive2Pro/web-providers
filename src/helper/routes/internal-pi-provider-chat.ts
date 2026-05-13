import type { FastifyInstance } from "fastify";
import type { ProviderChatRequest } from "../../shared/contracts";
import type { AppContext } from "../app";
import { HelperError } from "../errors";

const SESSION_HEADER = "x-pi-session-id";

export function registerInternalPiProviderChatRoute(
  app: FastifyInstance,
  ctx: AppContext,
) {
  app.post("/internal/pi/provider/chat", async (request, reply) => {
    const sessionId = request.headers[SESSION_HEADER] as string | undefined;
    if (!sessionId) {
      return reply.code(400).send({
        error: "AUTOMATION_DESYNC",
        message: "Missing x-pi-session-id header",
      });
    }

    const body = request.body as ProviderChatRequest;
    const abortController = new AbortController();
    const abortRequest = () => {
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    };
    const handleRequestAborted = () => {
      abortRequest();
    };
    const handleRequestClose = () => {
      if (request.raw.aborted) {
        abortRequest();
      }
    };
    request.raw.once("aborted", handleRequestAborted);
    request.raw.once("close", handleRequestClose);

    try {
      return await ctx.runtime.executeProviderChat({
        sessionId,
        body,
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }

      const helperError =
        error instanceof HelperError
          ? error
          : new HelperError("AUTOMATION_DESYNC", "Unexpected automation failure");
      return reply.code(409).send({
        error: helperError.code,
        message: helperError.message,
      });
    } finally {
      request.raw.off("aborted", handleRequestAborted);
      request.raw.off("close", handleRequestClose);
    }
  });
}

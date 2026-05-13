import type { FastifyInstance } from "fastify";
import type { ProviderChatRequest } from "../../shared/contracts";
import type { AppContext } from "../app";
import { HelperError } from "../errors";

const SESSION_HEADER = "x-web-providers-session-id";

export function registerProviderChatRoute(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/provider/chat", async (request, reply) => {
    const body = request.body as ProviderChatRequest;
    const sessionId = (request.headers[SESSION_HEADER] as string | undefined)?.trim();
    if (!sessionId) {
      return reply.code(400).send({
        error: "AUTOMATION_DESYNC",
        message: "Missing x-web-providers-session-id header",
      });
    }
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
    const handleResponseClose = () => {
      if (!reply.sent) {
        abortRequest();
      }
    };
    request.raw.once("aborted", handleRequestAborted);
    request.raw.once("close", handleRequestClose);
    reply.raw.once("close", handleResponseClose);

    try {
      const response = await ctx.runtime.executeProviderChat({
        sessionId,
        body,
        signal: abortController.signal,
      });
      return response;
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
      reply.raw.off("close", handleResponseClose);
    }
  });
}

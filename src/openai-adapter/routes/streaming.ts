import type { FastifyReply, FastifyRequest } from "fastify";
import type { ExecutionClient } from "../app";
import { AdapterError, unsupportedFeatureError } from "../errors";
import { mapHelperErrorCode } from "../errors";
import { getPublicModel } from "../models";
import type { NormalizedRequest, ExecutionResult } from "../types";
import { HelperError } from "../../helper/errors";
import type { NormalizeMode } from "../normalize";

type SerializedResultInput = {
  id: string;
  created: number;
  model: string;
  result: ExecutionResult;
};

type StreamCapableBody = {
  model: string;
  stream?: boolean;
};

type RequestHandlerInput<TBody extends StreamCapableBody> = {
  body: TBody;
  request: FastifyRequest;
  reply: FastifyReply;
  executionClient: ExecutionClient;
  idPrefix: string;
  normalize: (
    body: TBody,
    model: NonNullable<ReturnType<typeof getPublicModel>>,
    options: { mode: NormalizeMode },
  ) => NormalizedRequest;
  serialize: (input: SerializedResultInput) => unknown;
  serializeStream: (input: SerializedResultInput) => string[];
};

function resolvePublicSessionId(request: FastifyRequest) {
  const explicitHeader =
    (request.headers["x-web-providers-session-id"] as string | undefined) ??
    (request.headers["x-pi-session-id"] as string | undefined);

  if (explicitHeader && explicitHeader.trim().length > 0) {
    return explicitHeader.trim();
  }

  return `public-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export async function handlePseudoStreamRoute<TBody extends StreamCapableBody>(
  input: RequestHandlerInput<TBody>,
) {
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new AdapterError(400, "invalid_request", "Request body must be a JSON object");
  }

  if (typeof input.body.model !== "string" || input.body.model.trim().length === 0) {
    throw new AdapterError(400, "invalid_request", "model is required");
  }

  const model = getPublicModel(input.body.model);
  if (!model) {
    throw new AdapterError(404, "model_not_found", `Unknown model: ${input.body.model}`);
  }

  const mode: NormalizeMode = input.body.stream === true ? "buffered_streaming" : "json";
  const normalized = input.normalize(input.body, model, { mode });
  const result = await input.executionClient.run(normalized, {
    sessionId: resolvePublicSessionId(input.request),
  });

  const now = Date.now();
  const serializedInput: SerializedResultInput = {
    id: `${input.idPrefix}-${now}`,
    created: Math.floor(now / 1000),
    model: normalized.publicModel,
    result,
  };

  if (input.body.stream === true) {
    return input.reply
      .code(200)
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(input.serializeStream(serializedInput).join(""));
  }

  return input.serialize(serializedInput);
}

export function sendAdapterRouteError(error: unknown, reply: FastifyReply) {
  if (error instanceof Error && error.message === "Streaming is not supported") {
    const adapterError = unsupportedFeatureError(error.message);
    return reply.code(adapterError.statusCode).send({
      error: {
        code: adapterError.code,
        message: adapterError.message,
      },
    });
  }

  if (error instanceof AdapterError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  if (error instanceof HelperError) {
    const mapped = mapHelperErrorCode({
      code: error.code,
      message: error.message,
    });
    return reply.code(mapped.statusCode).send({
      error: {
        code: mapped.code,
        message: mapped.message,
      },
    });
  }

  throw error;
}

import type { FastifyReply } from "fastify";
import type { HelperClient } from "../app";
import { AdapterError, unsupportedFeatureError } from "../errors";
import { getPublicModel } from "../models";
import type { NormalizedRequest, ExecutionResult } from "../types";
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
  reply: FastifyReply;
  helperClient: HelperClient;
  idPrefix: string;
  normalize: (
    body: TBody,
    model: NonNullable<ReturnType<typeof getPublicModel>>,
    options: { mode: NormalizeMode },
  ) => NormalizedRequest;
  serialize: (input: SerializedResultInput) => unknown;
  serializeStream: (input: SerializedResultInput) => string[];
};

export async function handlePseudoStreamRoute<TBody extends StreamCapableBody>(
  input: RequestHandlerInput<TBody>,
) {
  const model = getPublicModel(input.body.model);
  if (!model) {
    throw new AdapterError(404, "model_not_found", `Unknown model: ${input.body.model}`);
  }

  const mode: NormalizeMode = input.body.stream === true ? "buffered_streaming" : "json";
  const normalized = input.normalize(input.body, model, { mode });
  const result = await input.helperClient.run(normalized);

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

  throw error;
}

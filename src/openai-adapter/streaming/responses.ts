import type {
  ResponsesCompletedEvent,
  ResponsesCreatedEvent,
  ResponsesEvent,
  ResponsesFunctionCallArgumentsDeltaEvent,
  ResponsesOutputTextDeltaEvent,
  StreamInput,
} from "./types";

function toSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function createdEvent(input: StreamInput): ResponsesCreatedEvent {
  return {
    type: "response.created",
    response: {
      id: input.id,
      object: "response",
      created_at: input.created,
      model: input.model,
    },
  };
}

function completedEvent(input: StreamInput): ResponsesCompletedEvent {
  return {
    type: "response.completed",
    response: {
      id: input.id,
      object: "response",
    },
  };
}

function outputTextDeltaEvent(delta: string): ResponsesOutputTextDeltaEvent {
  return {
    type: "response.output_text.delta",
    delta,
  };
}

function functionCallArgumentsDeltaEvent(input: {
  id: string;
  name: string;
  argumentsJson: string;
}): ResponsesFunctionCallArgumentsDeltaEvent {
  return {
    type: "response.function_call_arguments.delta",
    item_id: `${input.id}-tool-1`,
    name: input.name,
    delta: input.argumentsJson,
  };
}

export function serializeResponsesStream(input: StreamInput): string[] {
  const { id, created, model, result } = input;

  // Keep this serializer small and deterministic: we emit a short fixed sequence
  // of "responses" events, framed as SSE `data:` lines.
  const events: ResponsesEvent[] = [createdEvent(input)];

  if (result.mode === "text") {
    events.push(outputTextDeltaEvent(result.outputText));
    events.push(completedEvent(input));
    return events.map(toSseData);
  }

  events.push(
    functionCallArgumentsDeltaEvent({
      id,
      name: result.toolCall.name,
      argumentsJson: result.toolCall.argumentsJson,
    }),
  );
  events.push(completedEvent(input));
  return events.map(toSseData);
}

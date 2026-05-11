import { describe, expect, it } from "vitest";

import { serializeResponsesStream } from "../../src/openai-adapter/streaming/responses";

function parseSseDataLine(line: string): unknown {
  const prefix = "data: ";
  expect(line.startsWith(prefix)).toBe(true);
  expect(line.endsWith("\n\n")).toBe(true);

  const json = line.slice(prefix.length, -2);
  return JSON.parse(json);
}

describe("serializeResponsesStream", () => {
  it("serializes text output into SSE-framed response events", () => {
    const id = "resp_test_1";
    const created = 1710000000;
    const model = "test-model";

    const sse = serializeResponsesStream({
      id,
      created,
      model,
      result: {
        mode: "text",
        outputText: "hello",
        finishReason: "stop",
      },
    });

    expect(sse).toHaveLength(3);
    const events = sse.map(parseSseDataLine) as any[];

    expect(events[0].type).toBe("response.created");
    expect(events[0].response).toMatchObject({
      id,
      object: "response",
      created_at: created,
      model,
    });

    expect(events[1]).toMatchObject({
      type: "response.output_text.delta",
      delta: "hello",
    });

    expect(events[2].type).toBe("response.completed");
    expect(events[2].response).toMatchObject({
      id,
      object: "response",
    });
  });

  it("serializes tool calls into SSE-framed function-call events", () => {
    const id = "resp_test_2";
    const created = 1710000001;
    const model = "test-model";

    const sse = serializeResponsesStream({
      id,
      created,
      model,
      result: {
        mode: "native_tool_call",
        toolCalls: [
          {
            name: "ping",
            argumentsJson: "{\"text\":\"hi\"}",
          },
        ],
        finishReason: "stop",
      },
    });

    expect(sse).toHaveLength(3);
    const events = sse.map(parseSseDataLine) as any[];

    expect(events[0].type).toBe("response.created");
    expect(events[0].response).toMatchObject({
      id,
      object: "response",
      created_at: created,
      model,
    });

    expect(events[1].type).toBe("response.function_call_arguments.delta");
    expect(events[1]).toMatchObject({
      item_id: `${id}-tool-1`,
      name: "ping",
      delta: "{\"text\":\"hi\"}",
    });

    expect(events[2].type).toBe("response.completed");
    expect(events[2].response).toMatchObject({
      id,
      object: "response",
    });
  });

  it("serializes multiple tool calls into separate SSE function-call events", () => {
    const id = "resp_test_3";
    const created = 1710000002;
    const model = "test-model";

    const sse = serializeResponsesStream({
      id,
      created,
      model,
      result: {
        mode: "native_tool_call",
        toolCalls: [
          {
            name: "read_file",
            argumentsJson: "{\"path\":\"README.md\"}",
          },
          {
            name: "bash",
            argumentsJson: "{\"cmd\":\"pwd\"}",
          },
        ],
        finishReason: "stop",
      },
    });

    expect(sse).toHaveLength(4);
    const events = sse.map(parseSseDataLine) as any[];

    expect(events[1]).toMatchObject({
      type: "response.function_call_arguments.delta",
      item_id: `${id}-tool-1`,
      name: "read_file",
      delta: "{\"path\":\"README.md\"}",
    });
    expect(events[2]).toMatchObject({
      type: "response.function_call_arguments.delta",
      item_id: `${id}-tool-2`,
      name: "bash",
      delta: "{\"cmd\":\"pwd\"}",
    });
    expect(events[3].type).toBe("response.completed");
  });
});

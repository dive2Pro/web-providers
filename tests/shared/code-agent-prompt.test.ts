import { describe, expect, it } from "vitest";
import {
  ACTIONABLE_REPLY_RULE,
  CODE_AGENT_SYSTEM_PROMPT,
  JSON_PROTOCOL_RESPONSE_FORMAT_DECLARATION,
  OPTIONAL_TOOL_CONTENT_RULE,
} from "../../src/shared/code-agent-prompt";

describe("code agent prompt rules", () => {
  it("requires actionable replies in the long-lived system prompt", () => {
    expect(CODE_AGENT_SYSTEM_PROMPT).toContain(ACTIONABLE_REPLY_RULE);
  });

  it("requires actionable replies in the per-turn response declaration", () => {
    expect(JSON_PROTOCOL_RESPONSE_FORMAT_DECLARATION).toContain(
      ACTIONABLE_REPLY_RULE,
    );
  });

  it("documents optional tool-call content in both prompt layers", () => {
    expect(CODE_AGENT_SYSTEM_PROMPT).toContain(OPTIONAL_TOOL_CONTENT_RULE);
    expect(JSON_PROTOCOL_RESPONSE_FORMAT_DECLARATION).toContain(
      OPTIONAL_TOOL_CONTENT_RULE,
    );
  });
});

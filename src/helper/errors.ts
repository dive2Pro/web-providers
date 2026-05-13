import type { SendChatAutomationDebug } from "./browser/types";

export class HelperError extends Error {
  constructor(
    public readonly code:
      | "NOT_BOUND"
      | "PAGE_UNAVAILABLE"
      | "MODEL_BUSY"
      | "TIMEOUT"
      | "AUTOMATION_DESYNC"
      | "INVALID_PROVIDER_RESPONSE",
    message: string,
    public readonly automationDebug: SendChatAutomationDebug | null = null,
  ) {
    super(message);
  }
}

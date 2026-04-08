export class HelperError extends Error {
  constructor(
    public readonly code:
      | "NOT_BOUND"
      | "PAGE_UNAVAILABLE"
      | "MODEL_BUSY"
      | "TIMEOUT"
      | "AUTOMATION_DESYNC",
    message: string,
  ) {
    super(message);
  }
}

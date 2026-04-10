export class AdapterError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function mapHelperError(payload: { error?: string; message?: string }) {
  switch (payload.error) {
    case "NOT_BOUND":
      return new AdapterError(
        409,
        "provider_not_bound",
        payload.message ?? "Provider is not bound",
      );
    case "MODEL_BUSY":
      return new AdapterError(
        429,
        "model_busy",
        payload.message ?? "Model is busy",
      );
    case "TIMEOUT":
      return new AdapterError(
        504,
        "timeout",
        payload.message ?? "Request timed out",
      );
    case "AUTOMATION_DESYNC":
    case "PAGE_UNAVAILABLE":
      return new AdapterError(
        502,
        "upstream_failure",
        payload.message ?? "Upstream automation failed",
      );
    default:
      return new AdapterError(
        500,
        "internal_error",
        payload.message ?? "Unexpected helper error",
      );
  }
}

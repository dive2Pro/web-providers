export class AdapterError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function unsupportedFeatureError(message: string) {
  return new AdapterError(400, "unsupported_feature", message);
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
    case "INVALID_PROVIDER_RESPONSE":
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

export function mapHelperErrorCode(input: {
  code?: string;
  message?: string;
}) {
  return mapHelperError({
    error: input.code,
    message: input.message,
  });
}

export class AnthropicAdapterError extends Error {
  statusCode: number;
  type: string;

  constructor(statusCode: number, type: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.type = type;
  }
}

export function invalidRequestError(message: string) {
  return new AnthropicAdapterError(400, "invalid_request_error", message);
}

export function authenticationError(message: string) {
  return new AnthropicAdapterError(401, "authentication_error", message);
}

export function unsupportedFeatureError(message: string) {
  return new AnthropicAdapterError(400, "invalid_request_error", message);
}

export function mapHelperError(payload: { error?: string; message?: string }) {
  switch (payload.error) {
    case "NOT_BOUND":
      return new AnthropicAdapterError(
        409,
        "invalid_request_error",
        payload.message ?? "Provider is not bound",
      );
    case "MODEL_BUSY":
      return new AnthropicAdapterError(
        429,
        "rate_limit_error",
        payload.message ?? "Model is busy",
      );
    case "TIMEOUT":
      return new AnthropicAdapterError(
        504,
        "api_error",
        payload.message ?? "Request timed out",
      );
    case "AUTOMATION_DESYNC":
    case "PAGE_UNAVAILABLE":
      return new AnthropicAdapterError(
        502,
        "api_error",
        payload.message ?? "Upstream automation failed",
      );
    default:
      return new AnthropicAdapterError(
        500,
        "api_error",
        payload.message ?? "Unexpected helper error",
      );
  }
}

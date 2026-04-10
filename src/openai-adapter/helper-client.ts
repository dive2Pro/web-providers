import type { ProviderChatRequest, ProviderChatResponse } from "../shared/contracts";
import { mapHelperError } from "./errors";
import type { NormalizedRequest } from "./types";

type FetchImpl = typeof fetch;

export function createHelperClient(input: {
  helperBaseUrl: string;
  helperToken: string;
  fetchImpl?: FetchImpl;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async run(request: NormalizedRequest): Promise<ProviderChatResponse> {
      const helperRequest: ProviderChatRequest = {
        provider: request.provider,
        model: request.publicModel,
        messages: request.messages,
        ...(typeof request.temperature === "number"
          ? { temperature: request.temperature }
          : {}),
        ...(typeof request.maxOutputTokens === "number"
          ? { maxOutputTokens: request.maxOutputTokens }
          : {}),
      };

      const response = await fetchImpl(
        `${input.helperBaseUrl}/v1/provider/chat`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.helperToken}`,
          },
          body: JSON.stringify(helperRequest),
        },
      );

      const payload = (await response.json()) as
        | ProviderChatResponse
        | { error?: string; message?: string };

      if (!response.ok) {
        throw mapHelperError(payload as { error?: string; message?: string });
      }

      return payload as ProviderChatResponse;
    },
  };
}

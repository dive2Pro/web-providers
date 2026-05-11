import { getPublicModel, listPublicModels } from "../openai-adapter/models";

export type AnthropicGatewayModel = {
  id: string;
  upstreamModelId: string;
  displayName: string;
  description: string;
  createdAt: string;
};

const MODEL_PREFIX = "anthropic-";

function toDisplayName(modelId: string) {
  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function listAnthropicPublicModels(): AnthropicGatewayModel[] {
  return listPublicModels().map((model) => ({
    id: `${MODEL_PREFIX}${model.id}`,
    upstreamModelId: model.id,
    displayName: `${toDisplayName(model.id)} via Gateway`,
    description: `Routes ${model.id} through the local web-providers gateway`,
    createdAt: "2026-05-11T00:00:00Z",
  }));
}

export function getAnthropicPublicModel(modelId: string) {
  const fromDirectId = getPublicModel(modelId);
  if (fromDirectId) {
    return fromDirectId;
  }

  const aliasedModelId = modelId.startsWith(MODEL_PREFIX)
    ? modelId.slice(MODEL_PREFIX.length)
    : modelId;

  return getPublicModel(aliasedModelId);
}

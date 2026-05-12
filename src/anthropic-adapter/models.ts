import { getPublicModel, listPublicModels } from "../openai-adapter/models";

export type AnthropicGatewayModel = {
  id: string;
  upstreamModelId: string;
  displayName: string;
  description: string;
  createdAt: string;
};

function toDisplayName(modelId: string) {
  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function listAnthropicPublicModels(): AnthropicGatewayModel[] {
  return listPublicModels().map((model) => ({
    id: model.id,
    upstreamModelId: model.id,
    displayName: `${toDisplayName(model.id)} via Gateway`,
    description: `Routes ${model.id} through the local web-providers gateway`,
    createdAt: "2026-05-11T00:00:00Z",
  }));
}

export function getAnthropicPublicModel(modelId: string) {
  return getPublicModel(modelId);
}

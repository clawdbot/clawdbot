import { loadBundledPluginContractApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type AnthropicContractSurface = typeof import("@openclaw/anthropic/contract-api.js");

let anthropicContractSurface: AnthropicContractSurface | undefined;

function getAnthropicContractSurface(): AnthropicContractSurface {
  anthropicContractSurface ??=
    loadBundledPluginContractApiSync<AnthropicContractSurface>("anthropic");
  return anthropicContractSurface;
}

export const createAnthropicBetaHeadersWrapper = (
  ...args: Parameters<AnthropicContractSurface["createAnthropicBetaHeadersWrapper"]>
) => getAnthropicContractSurface().createAnthropicBetaHeadersWrapper(...args);

export const createAnthropicFastModeWrapper = (
  ...args: Parameters<AnthropicContractSurface["createAnthropicFastModeWrapper"]>
) => getAnthropicContractSurface().createAnthropicFastModeWrapper(...args);

export const createAnthropicServiceTierWrapper = (
  ...args: Parameters<AnthropicContractSurface["createAnthropicServiceTierWrapper"]>
) => getAnthropicContractSurface().createAnthropicServiceTierWrapper(...args);

export const resolveAnthropicBetas = (
  ...args: Parameters<AnthropicContractSurface["resolveAnthropicBetas"]>
) => getAnthropicContractSurface().resolveAnthropicBetas(...args);

export const resolveAnthropicFastMode = (
  ...args: Parameters<AnthropicContractSurface["resolveAnthropicFastMode"]>
) => getAnthropicContractSurface().resolveAnthropicFastMode(...args);

export const resolveAnthropicServiceTier = (
  ...args: Parameters<AnthropicContractSurface["resolveAnthropicServiceTier"]>
) => getAnthropicContractSurface().resolveAnthropicServiceTier(...args);

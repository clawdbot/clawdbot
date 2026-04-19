import { loadBundledPluginContractApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type AnthropicContractSurface = {
  createAnthropicBetaHeadersWrapper: (...args: unknown[]) => unknown;
  createAnthropicFastModeWrapper: (...args: unknown[]) => unknown;
  createAnthropicServiceTierWrapper: (...args: unknown[]) => unknown;
  resolveAnthropicBetas: (...args: unknown[]) => unknown;
  resolveAnthropicFastMode: (...args: unknown[]) => unknown;
  resolveAnthropicServiceTier: (...args: unknown[]) => unknown;
};

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

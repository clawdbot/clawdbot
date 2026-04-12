import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import type { ModelApi } from "openclaw/plugin-sdk/provider-onboard";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  createConfigWithFallbacks,
  createLegacyProviderConfig,
  EXPECTED_FALLBACKS,
} from "./onboard-config.js";

export function expectProviderOnboardAllowlistAlias(params: {
  applyProviderConfig: (config: OpenClawConfig) => OpenClawConfig;
  modelRef: string;
  alias: string;
}) {
  const withDefault = params.applyProviderConfig({});
  expect(Object.keys(withDefault.agents?.defaults?.models ?? {})).toContain(params.modelRef);

  const withAlias = params.applyProviderConfig({
    agents: {
      defaults: {
        models: {
          [params.modelRef]: { alias: params.alias },
        },
      },
    },
  });
  expect(withAlias.agents?.defaults?.models?.[params.modelRef]?.alias).toBe(params.alias);
}

export function expectProviderOnboardPrimaryAndFallbacks(params: {
  applyConfig: (config: OpenClawConfig) => OpenClawConfig;
  modelRef: string;
}) {
  expectProviderOnboardPrimaryModel(params);

  const cfgWithFallbacks = params.applyConfig(createConfigWithFallbacks());
  expect(resolveAgentModelFallbackValues(cfgWithFallbacks.agents?.defaults?.model)).toEqual([
    ...EXPECTED_FALLBACKS,
  ]);
}

export function expectProviderOnboardPrimaryModel(params: {
  applyConfig: (config: OpenClawConfig) => OpenClawConfig;
  modelRef: string;
}) {
  const cfg = params.applyConfig({});
  expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(params.modelRef);
}

export function expectProviderOnboardPreservesPrimary(params: {
  applyProviderConfig: (config: OpenClawConfig) => OpenClawConfig;
  primaryModelRef: string;
}) {
  const cfg = params.applyProviderConfig({
    agents: { defaults: { model: { primary: params.primaryModelRef } } },
  });
  expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(params.primaryModelRef);
}

export function expectProviderOnboardMergedLegacyConfig(params: {
  applyProviderConfig: (config: OpenClawConfig) => OpenClawConfig;
  providerId: string;
  providerApi: ModelApi;
  baseUrl: string;
  legacyApi: Parameters<typeof createLegacyProviderConfig>[0]["api"];
  legacyModelId?: string;
  legacyModelName?: string;
  legacyBaseUrl?: string;
  legacyApiKey?: string;
}) {
  const cfg = params.applyProviderConfig(
    createLegacyProviderConfig({
      providerId: params.providerId,
      api: params.legacyApi,
      modelId: params.legacyModelId,
      modelName: params.legacyModelName,
      baseUrl: params.legacyBaseUrl,
      apiKey: params.legacyApiKey,
    }),
  );

  const provider = cfg.models?.providers?.[params.providerId];
  expect(provider?.baseUrl).toBe(params.baseUrl);
  expect(provider?.api).toBe(params.providerApi);
  expect(provider?.apiKey).toBe((params.legacyApiKey ?? "old-key").trim());
  return provider;
}

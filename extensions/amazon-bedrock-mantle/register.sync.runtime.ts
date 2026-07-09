/**
 * Synchronous Amazon Bedrock Mantle provider registration. It wires discovery,
 * runtime bearer-token preparation, stream wrappers, and failover classifiers.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { OpenClawPluginApi, ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  modelCostsEqual,
  resolveClaudeSonnet5ModelIdentity,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  mergeImplicitMantleProvider,
  resolveImplicitMantleProvider,
  resolveMantleBearerToken,
  resolveMantleRuntimeBearerToken,
  resolveMantleSonnet5Cost,
} from "./discovery.js";
import { createMantleAnthropicStreamFn } from "./mantle-anthropic.runtime.js";

type BedrockMantlePluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

function normalizeMantleResolvedModel(params: {
  modelId: string;
  model: ProviderRuntimeModel;
}): ProviderRuntimeModel | undefined {
  if (
    resolveClaudeSonnet5ModelIdentity({ id: params.modelId, params: params.model.params }) ===
    undefined
  ) {
    return undefined;
  }
  const cost = resolveMantleSonnet5Cost();
  if (modelCostsEqual(params.model.cost, cost)) {
    return undefined;
  }
  return { ...params.model, cost };
}

/** Register the Amazon Bedrock Mantle provider with OpenClaw. */
export function registerBedrockMantlePlugin(api: OpenClawPluginApi): void {
  const providerId = "amazon-bedrock-mantle";
  const startupPluginConfig = (api.pluginConfig ?? {}) as BedrockMantlePluginConfig;

  function resolveCurrentPluginConfig(
    config: OpenClawConfig | undefined,
  ): BedrockMantlePluginConfig | undefined {
    const runtimePluginConfig = resolvePluginConfigObject(config, providerId);
    return (
      (runtimePluginConfig as BedrockMantlePluginConfig | undefined) ??
      (config ? undefined : startupPluginConfig)
    );
  }

  api.registerProvider({
    id: providerId,
    label: "Amazon Bedrock Mantle (OpenAI-compatible)",
    docsPath: "/providers/bedrock-mantle",
    auth: [],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const currentPluginConfig = resolveCurrentPluginConfig(ctx.config);
        const implicit = await resolveImplicitMantleProvider({
          env: ctx.env,
          pluginConfig: currentPluginConfig,
        });
        if (!implicit) {
          return null;
        }
        return {
          provider: mergeImplicitMantleProvider({
            existing: ctx.config.models?.providers?.[providerId],
            implicit,
          }),
        };
      },
    },
    resolveConfigApiKey: ({ env }) =>
      resolveMantleBearerToken(env) ? "env:AWS_BEARER_TOKEN_BEDROCK" : undefined,
    prepareRuntimeAuth: async ({ apiKey, env }) =>
      await resolveMantleRuntimeBearerToken({
        apiKey,
        env,
      }),
    normalizeResolvedModel: ({ modelId, model }) =>
      normalizeMantleResolvedModel({ modelId, model }),
    createStreamFn: ({ model }) =>
      model.api === "anthropic-messages" ? createMantleAnthropicStreamFn() : undefined,
    matchesContextOverflowError: ({ errorMessage }) =>
      /context_length_exceeded|max.*tokens.*exceeded/i.test(errorMessage),
    classifyFailoverReason: ({ errorMessage }) => {
      if (/rate_limit|too many requests|429/i.test(errorMessage)) {
        return "rate_limit";
      }
      if (/overloaded|503|service.*unavailable/i.test(errorMessage)) {
        return "overloaded";
      }
      return undefined;
    },
  });
}

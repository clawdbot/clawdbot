import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyKimiCodeConfig, KIMI_CODING_MODEL_REF } from "./onboard.js";
import { buildKimiCodingProvider, normalizeKimiCodingModelId } from "./provider-catalog.js";
import { KIMI_REPLAY_POLICY } from "./replay-policy.js";
import { wrapKimiProviderStream } from "./stream.js";

const PLUGIN_ID = "kimi";
const PROVIDER_ID = "kimi";

function findExplicitProviderConfig(
  providers: Record<string, unknown> | undefined,
  providerId: string,
): Record<string, unknown> | undefined {
  if (!providers) {
    return undefined;
  }
  const normalizedProviderId = normalizeProviderId(providerId);
  const match = Object.entries(providers).find(
    ([configuredProviderId]) => normalizeProviderId(configuredProviderId) === normalizedProviderId,
  );
  return isRecord(match?.[1]) ? match[1] : undefined;
}
export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Kimi Provider",
  description: "Bundled Kimi provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Kimi",
      aliases: ["kimi-code", "kimi-coding"],
      docsPath: "/providers/moonshot",
      envVars: ["KIMI_API_KEY", "KIMICODE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Kimi Code API key (subscription)",
          hint: "Kimi K2.6 + Kimi",
          optionKey: "kimiCodeApiKey",
          flagName: "--kimi-code-api-key",
          envVar: "KIMI_API_KEY",
          promptMessage: "Enter Kimi API key",
          defaultModel: KIMI_CODING_MODEL_REF,
          expectedProviders: ["kimi", "kimi-code", "kimi-coding"],
          applyConfig: (cfg) => applyKimiCodeConfig(cfg),
          noteMessage: [
            "Kimi uses a dedicated coding endpoint and API key.",
            "Get your API key at: https://www.kimi.com/code/en",
          ].join("\n"),
          noteTitle: "Kimi",
          wizard: {
            choiceId: "kimi-code-api-key",
            choiceLabel: "Kimi Code API key (subscription)",
            groupId: "moonshot",
            groupLabel: "Moonshot AI (Kimi K2.6)",
            groupHint: "Kimi K2.6",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          const explicitProvider = findExplicitProviderConfig(
            ctx.config.models?.providers as Record<string, unknown> | undefined,
            PROVIDER_ID,
          );
          const builtInProvider = buildKimiCodingProvider();
          const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl) ?? "";
          const explicitHeaders = isRecord(explicitProvider?.headers)
            ? (explicitProvider.headers as Record<string, SecretInput>)
            : undefined;
          return {
            provider: {
              ...builtInProvider,
              ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
              ...(explicitHeaders
                ? {
                    headers: {
                      ...builtInProvider.headers,
                      ...explicitHeaders,
                    },
                  }
                : {}),
              apiKey,
            },
          };
        },
      },
      buildReplayPolicy: () => KIMI_REPLAY_POLICY,
      normalizeResolvedModel: ({ model }) => {
        const normalizedId = normalizeKimiCodingModelId(model.id);
        return normalizedId === model.id ? undefined : { ...model, id: normalizedId };
      },
      resolveThinkingProfile: () => ({
        levels: [
          { id: "off", label: "off" },
          { id: "low", label: "on" },
        ],
        defaultLevel: "off",
      }),
      wrapStreamFn: wrapKimiProviderStream,
    });
  },
});

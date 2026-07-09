// Qwen plugin entrypoint registers its OpenClaw integration.
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyQwenNativeStreamingUsageCompat } from "./api.js";
import { buildQwenMediaUnderstandingProvider } from "./media-understanding-provider.js";
import {
  isQwenCodingPlanBaseUrl,
  isQwenStandardOnlyModelId,
  isQwenTokenPlanDeepSeekV4ModelId,
  isQwenTokenPlanGlmModelId,
  isQwenTokenPlanThinkingOnlyModelId,
  QWEN_BASE_URL,
  QWEN_DEFAULT_MODEL_REF,
  QWEN_OAUTH_DEFAULT_MODEL_REF,
  QWEN_OAUTH_PROVIDER_ID,
  QWEN_TOKEN_PLAN_DEFAULT_MODEL_REF,
  QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID,
  QWEN_TOKEN_PLAN_PROVIDER_ID,
  supportsQwenTokenPlanGlmMaxThinking,
} from "./models.js";
import {
  applyQwenConfig,
  applyQwenConfigCn,
  applyQwenOAuthConfig,
  applyQwenStandardConfig,
  applyQwenStandardConfigCn,
  applyQwenTokenPlanConfig,
} from "./onboard.js";
import {
  buildQwenOAuthProvider,
  buildQwenProvider,
  buildQwenTokenPlanProvider,
} from "./provider-catalog.js";
import { wrapQwenProviderStream } from "./stream.js";
import { buildQwenVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "qwen";
const LEGACY_PROVIDER_ID = "modelstudio";
const QWEN_OAUTH_AUTH_PROVIDER_IDS = [QWEN_OAUTH_PROVIDER_ID, "qwen-portal", "qwen-cli"] as const;
const QWEN_TOKEN_PLAN_THINKING_LEVEL_IDS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const QWEN_TOKEN_PLAN_GLM_NO_MAX_THINKING_LEVEL_IDS = QWEN_TOKEN_PLAN_THINKING_LEVEL_IDS.filter(
  (id) => id !== "max",
);

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase();
}

function resolveConfiguredQwenBaseUrl(
  config: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
): string | undefined {
  const providers = config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    const normalized = normalizeProviderId(providerId);
    if (normalized !== PROVIDER_ID && normalized !== LEGACY_PROVIDER_ID) {
      continue;
    }
    const baseUrl = provider?.baseUrl?.trim();
    if (baseUrl) {
      return baseUrl;
    }
  }
  return undefined;
}

function resolveConfiguredQwenTokenPlanBaseUrl(
  config: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
): string | undefined {
  const providers = config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    const normalized = normalizeProviderId(providerId);
    if (normalized !== QWEN_TOKEN_PLAN_PROVIDER_ID) {
      continue;
    }
    const baseUrl = provider?.baseUrl?.trim();
    if (baseUrl) {
      return baseUrl;
    }
  }
  return undefined;
}

function createQwenTokenPlanAuthMethod(region: "global" | "cn") {
  const isCn = region === "cn";
  const regionLabel = isCn ? "China" : "Global/Intl";
  const host = isCn
    ? "token-plan.cn-beijing.maas.aliyuncs.com"
    : "token-plan.ap-southeast-1.maas.aliyuncs.com";
  return createProviderApiKeyAuthMethod({
    providerId: QWEN_TOKEN_PLAN_PROVIDER_ID,
    methodId: isCn ? "api-key-cn" : "api-key",
    label: `Qwen Token Plan API Key for ${regionLabel} (subscription)`,
    hint: `Endpoint: ${host}`,
    optionKey: isCn ? "qwenTokenPlanApiKeyCn" : "qwenTokenPlanApiKey",
    flagName: isCn ? "--qwen-token-plan-api-key-cn" : "--qwen-token-plan-api-key",
    envVar: "QWEN_TOKEN_PLAN_API_KEY",
    promptMessage: `Enter Alibaba Qwen Token Plan API key (${regionLabel}, sk-sp-...)`,
    defaultModel: QWEN_TOKEN_PLAN_DEFAULT_MODEL_REF,
    applyConfig: (cfg) => applyQwenTokenPlanConfig(cfg, region),
    wizard: {
      choiceId: isCn ? "qwen-token-plan-cn" : "qwen-token-plan",
      choiceLabel: `Qwen Token Plan (${regionLabel})`,
      choiceHint: `Endpoint: ${host}`,
      groupId: "qwen",
      groupLabel: "Qwen Cloud",
      groupHint: "Standard / Coding Plan / Token Plan / OAuth",
    },
  });
}

function resolveQwenTokenPlanThinkingProfile(modelId: string) {
  if (isQwenTokenPlanThinkingOnlyModelId(modelId)) {
    return {
      levels: [{ id: "low" as const, label: "on" }],
      defaultLevel: "low" as const,
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  if (isQwenTokenPlanDeepSeekV4ModelId(modelId)) {
    return {
      levels: QWEN_TOKEN_PLAN_THINKING_LEVEL_IDS.map((id) => ({ id })),
      defaultLevel: "high" as const,
    };
  }
  if (isQwenTokenPlanGlmModelId(modelId)) {
    const levels = supportsQwenTokenPlanGlmMaxThinking(modelId)
      ? QWEN_TOKEN_PLAN_THINKING_LEVEL_IDS
      : QWEN_TOKEN_PLAN_GLM_NO_MAX_THINKING_LEVEL_IDS;
    return {
      levels: levels.map((id) => ({ id })),
      defaultLevel: "high" as const,
    };
  }
  return undefined;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Qwen Provider",
  description: "Bundled Qwen Cloud provider plugin",
  provider: {
    label: "Qwen Cloud",
    docsPath: "/providers/qwen",
    aliases: ["modelstudio", "qwencloud"],
    auth: [
      {
        methodId: "standard-api-key-cn",
        label: "Standard API Key for China (pay-as-you-go)",
        hint: "Endpoint: dashscope.aliyuncs.com",
        optionKey: "modelstudioStandardApiKeyCn",
        flagName: "--modelstudio-standard-api-key-cn",
        envVar: "QWEN_API_KEY",
        promptMessage: "Enter Qwen Cloud API key (China standard endpoint)",
        defaultModel: QWEN_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyQwenStandardConfigCn(cfg),
        noteMessage: [
          "Manage API keys: https://home.qwencloud.com/api-keys",
          "Docs: https://docs.qwencloud.com/",
          "Endpoint: dashscope.aliyuncs.com/compatible-mode/v1",
          "Models: qwen3.7-max, qwen3.7-plus, qwen3.6-plus, qwen3.6-flash, qwen3.5-plus, etc.",
        ].join("\n"),
        noteTitle: "Qwen Cloud Standard (China)",
        wizard: {
          choiceHint: "Endpoint: dashscope.aliyuncs.com",
          groupLabel: "Qwen Cloud",
          groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap",
        },
      },
      {
        methodId: "standard-api-key",
        label: "Standard API Key for Global/Intl (pay-as-you-go)",
        hint: "Endpoint: dashscope-intl.aliyuncs.com",
        optionKey: "modelstudioStandardApiKey",
        flagName: "--modelstudio-standard-api-key",
        envVar: "QWEN_API_KEY",
        promptMessage: "Enter Qwen Cloud API key (Global/Intl standard endpoint)",
        defaultModel: QWEN_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyQwenStandardConfig(cfg),
        noteMessage: [
          "Manage API keys: https://home.qwencloud.com/api-keys",
          "Docs: https://docs.qwencloud.com/",
          "Endpoint: dashscope-intl.aliyuncs.com/compatible-mode/v1",
          "Models: qwen3.7-max, qwen3.7-plus, qwen3.6-plus, qwen3.6-flash, qwen3.5-plus, etc.",
        ].join("\n"),
        noteTitle: "Qwen Cloud Standard (Global/Intl)",
        wizard: {
          choiceHint: "Endpoint: dashscope-intl.aliyuncs.com",
          groupLabel: "Qwen Cloud",
          groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap",
        },
      },
      {
        methodId: "api-key-cn",
        label: "Coding Plan API Key for China (subscription)",
        hint: "Endpoint: coding.dashscope.aliyuncs.com",
        optionKey: "modelstudioApiKeyCn",
        flagName: "--modelstudio-api-key-cn",
        envVar: "QWEN_API_KEY",
        promptMessage: "Enter Qwen Cloud Coding Plan API key (China)",
        defaultModel: QWEN_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyQwenConfigCn(cfg),
        noteMessage: [
          "Manage API keys: https://home.qwencloud.com/api-keys",
          "Docs: https://docs.qwencloud.com/",
          "Endpoint: coding.dashscope.aliyuncs.com",
          "Models: qwen3.5-plus, glm-5, kimi-k2.5, MiniMax-M2.5, etc.",
        ].join("\n"),
        noteTitle: "Qwen Cloud Coding Plan (China)",
        wizard: {
          choiceHint: "Endpoint: coding.dashscope.aliyuncs.com",
          groupLabel: "Qwen Cloud",
          groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap",
        },
      },
      {
        methodId: "api-key",
        label: "Coding Plan API Key for Global/Intl (subscription)",
        hint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
        optionKey: "modelstudioApiKey",
        flagName: "--modelstudio-api-key",
        envVar: "QWEN_API_KEY",
        promptMessage: "Enter Qwen Cloud Coding Plan API key (Global/Intl)",
        defaultModel: QWEN_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyQwenConfig(cfg),
        noteMessage: [
          "Manage API keys: https://home.qwencloud.com/api-keys",
          "Docs: https://docs.qwencloud.com/",
          "Endpoint: coding-intl.dashscope.aliyuncs.com",
          "Models: qwen3.5-plus, glm-5, kimi-k2.5, MiniMax-M2.5, etc.",
        ].join("\n"),
        noteTitle: "Qwen Cloud Coding Plan (Global/Intl)",
        wizard: {
          choiceHint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
          groupLabel: "Qwen Cloud",
          groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap",
        },
      },
    ],
    catalog: {
      run: async (ctx) => {
        const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
        if (!apiKey) {
          return null;
        }
        const baseUrl = resolveConfiguredQwenBaseUrl(ctx.config) ?? QWEN_BASE_URL;
        return {
          provider: {
            ...buildQwenProvider({ baseUrl }),
            apiKey,
          },
        };
      },
    },
    applyNativeStreamingUsageCompat: ({ providerConfig }) =>
      applyQwenNativeStreamingUsageCompat(providerConfig),
    wrapStreamFn: wrapQwenProviderStream,
    normalizeConfig: ({ providerConfig }) => {
      if (!isQwenCodingPlanBaseUrl(providerConfig.baseUrl)) {
        return undefined;
      }
      const models = providerConfig.models?.filter((model) => !isQwenStandardOnlyModelId(model.id));
      return models && models.length !== providerConfig.models?.length
        ? { ...providerConfig, models }
        : undefined;
    },
  },
  register(api) {
    api.registerProvider({
      id: QWEN_OAUTH_PROVIDER_ID,
      label: "Qwen OAuth",
      docsPath: "/providers/qwen",
      aliases: ["qwen-portal", "qwen-cli"],
      envVars: ["QWEN_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: QWEN_OAUTH_PROVIDER_ID,
          methodId: "api-key",
          label: "Qwen OAuth token",
          hint: "Portal token for portal.qwen.ai",
          optionKey: "qwenOauthToken",
          flagName: "--qwen-oauth-token",
          envVar: "QWEN_API_KEY",
          promptMessage: "Enter Qwen OAuth token",
          defaultModel: QWEN_OAUTH_DEFAULT_MODEL_REF,
          applyConfig: (cfg) => applyQwenOAuthConfig(cfg),
          wizard: {
            choiceId: QWEN_OAUTH_PROVIDER_ID,
            choiceLabel: "Qwen OAuth",
            choiceHint: "Portal token for portal.qwen.ai",
            groupId: "qwen",
            groupLabel: "Qwen Cloud",
            groupHint: "Standard / Coding Plan / OAuth",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = QWEN_OAUTH_AUTH_PROVIDER_IDS.map(
            (providerId) => ctx.resolveProviderApiKey(providerId).apiKey,
          ).find(
            (candidate): candidate is string =>
              typeof candidate === "string" && candidate.length > 0,
          );
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildQwenOAuthProvider(),
              apiKey,
            },
          };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: buildQwenOAuthProvider(),
        }),
      },
      wrapStreamFn: wrapQwenProviderStream,
    });
    api.registerProvider({
      id: QWEN_TOKEN_PLAN_PROVIDER_ID,
      label: "Qwen Token Plan",
      docsPath: "/providers/qwen",
      envVars: ["QWEN_TOKEN_PLAN_API_KEY"],
      auth: [createQwenTokenPlanAuthMethod("global"), createQwenTokenPlanAuthMethod("cn")],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(QWEN_TOKEN_PLAN_PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          const baseUrl = resolveConfiguredQwenTokenPlanBaseUrl(ctx.config);
          return {
            provider: {
              ...buildQwenTokenPlanProvider({ baseUrl }),
              apiKey,
            },
          };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: buildQwenTokenPlanProvider(),
        }),
      },
      applyNativeStreamingUsageCompat: ({ providerConfig }) =>
        applyQwenNativeStreamingUsageCompat(providerConfig),
      wrapStreamFn: wrapQwenProviderStream,
      resolveThinkingProfile: ({ modelId }) => resolveQwenTokenPlanThinkingProfile(modelId),
    });
    api.registerProvider({
      id: QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID,
      label: "Alibaba Token Plan (legacy custom config)",
      docsPath: "/providers/qwen",
      auth: [],
      applyNativeStreamingUsageCompat: ({ providerConfig }) =>
        applyQwenNativeStreamingUsageCompat(providerConfig),
      wrapStreamFn: wrapQwenProviderStream,
    });
    api.registerMediaUnderstandingProvider(buildQwenMediaUnderstandingProvider());
    api.registerVideoGenerationProvider(buildQwenVideoGenerationProvider());
  },
});

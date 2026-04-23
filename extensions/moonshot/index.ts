import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { MOONSHOT_THINKING_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";
import { applyMoonshotNativeStreamingUsageCompat } from "./api.js";
import { moonshotMediaUnderstandingProvider } from "./media-understanding-provider.js";
import {
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildMoonshotProvider } from "./provider-catalog.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const PROVIDER_ID = "moonshot";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Moonshot Provider",
  description: "Bundled Moonshot provider plugin",
  provider: {
    label: "Moonshot",
    docsPath: "/providers/moonshot",
    auth: [
      {
        methodId: "api-key",
        label: "Kimi API key (.ai)",
        hint: "Kimi K2.6 + Kimi",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMoonshotConfig(cfg),
        wizard: {
          groupLabel: "Moonshot AI (Kimi K2.6)",
        },
      },
      {
        methodId: "api-key-cn",
        label: "Kimi API key (.cn)",
        hint: "Kimi K2.6 + Kimi",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key (.cn)",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMoonshotConfigCn(cfg),
        wizard: {
          groupLabel: "Moonshot AI (Kimi K2.6)",
        },
      },
    ],
    catalog: {
      buildProvider: buildMoonshotProvider,
      buildStaticProvider: buildMoonshotProvider,
      allowExplicitBaseUrl: true,
    },
    applyNativeStreamingUsageCompat: ({ providerConfig }) =>
      applyMoonshotNativeStreamingUsageCompat(providerConfig),
    // Kimi K2+ returns native tool_call IDs shaped like `functions.<name>:<index>`.
    // Sanitizing them to alphanumeric-only breaks Kimi's serving-layer matching in
    // multi-turn replay. See openclaw/openclaw#62319.
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      sanitizeToolCallIds: false,
    }),
    ...MOONSHOT_THINKING_STREAM_HOOKS,
    resolveThinkingProfile: () => ({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    }),
  },
  register(api) {
    api.registerMediaUnderstandingProvider(moonshotMediaUnderstandingProvider);
    api.registerWebSearchProvider(createKimiWebSearchProvider());
  },
});

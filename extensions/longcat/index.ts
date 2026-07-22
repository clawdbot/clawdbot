// LongCat plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { LONGCAT_DEFAULT_MODEL_REF } from "./models.js";
import { applyLongCatConfig } from "./onboard.js";
import { buildLongCatProvider } from "./provider-catalog.js";
import { createLongCatThinkingWrapper } from "./stream.js";

const PROVIDER_ID = "longcat";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "LongCat Provider",
  description: "Official LongCat provider plugin",
  provider: {
    label: "LongCat",
    docsPath: "/providers/longcat",
    aliases: ["meituan-longcat"],
    envVars: ["LONGCAT_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "LongCat API key",
        hint: "API key",
        optionKey: "longcatApiKey",
        flagName: "--longcat-api-key",
        envVar: "LONGCAT_API_KEY",
        promptMessage: "Enter LongCat API key",
        defaultModel: LONGCAT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyLongCatConfig(cfg),
        noteTitle: "LongCat",
        noteMessage: "Manage API keys at https://longcat.chat/platform/api_keys",
        wizard: {
          choiceId: "longcat-api-key",
          choiceLabel: "LongCat API key",
          groupId: "longcat",
          groupLabel: "LongCat",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildLongCatProvider,
      buildStaticProvider: buildLongCatProvider,
      liveModelDiscovery: true,
    },
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
    wrapStreamFn: (ctx) => createLongCatThinkingWrapper(ctx.streamFn, ctx.thinkingLevel),
  },
});

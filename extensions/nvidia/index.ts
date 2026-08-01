// Nvidia plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyNvidiaConfig, NVIDIA_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildLiveNvidiaProvider,
  buildSelectableNvidiaProvider,
  buildSelectableLiveNvidiaProvider,
} from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";

function hasNvidiaApiToken(ctx: {
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey?: (providerId?: string) => { apiKey: string | undefined };
}) {
  return Boolean(
    ctx.resolveProviderApiKey?.(PROVIDER_ID).apiKey?.trim() || ctx.env.NVIDIA_API_KEY?.trim(),
  );
}

async function buildNvidiaCatalogModels(ctx: {
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey?: (providerId?: string) => { apiKey: string | undefined };
}) {
  const provider = hasNvidiaApiToken(ctx)
    ? await buildLiveNvidiaProvider()
    : buildSelectableNvidiaProvider();
  return provider.models.map((model) => ({
    provider: PROVIDER_ID,
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    input: model.input,
  }));
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "NVIDIA Provider",
  description: "Bundled NVIDIA provider plugin",
  manifest,
  provider: {
    label: "NVIDIA",
    docsPath: "/providers/nvidia",
    preserveLiteralProviderPrefix: true,
    manifestAuth: {
      defaultModel: NVIDIA_DEFAULT_MODEL_REF,
      applyConfig: applyNvidiaConfig,
    },
    catalog: {
      buildProvider: buildSelectableLiveNvidiaProvider,
      buildStaticProvider: buildSelectableNvidiaProvider,
    },
    augmentModelCatalog: buildNvidiaCatalogModels,
    wizard: {
      setup: {
        choiceId: "nvidia-api-key",
        choiceLabel: "NVIDIA API key",
        groupId: "nvidia",
        groupLabel: "NVIDIA",
        groupHint: "Direct API key",
        methodId: "api-key",
        modelSelection: {
          promptWhenAuthChoiceProvided: true,
          allowKeepCurrent: false,
        },
      },
      modelPicker: {
        label: "NVIDIA (custom)",
        hint: "Use NVIDIA-hosted open models",
        methodId: "api-key",
      },
    },
  },
});

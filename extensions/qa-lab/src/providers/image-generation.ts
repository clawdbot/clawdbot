// Qa Lab plugin module implements image generation behavior.
import {
  normalizeTrimmedStringList,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  QA_BASE_RUNTIME_PLUGIN_IDS,
  QA_CODEX_OPENAI_CATALOG_BASE_URL,
} from "../qa-gateway-config.js";
import type { RuntimeId } from "../runtime-parity.js";
import type { QaProviderMode } from "./index.js";
import { getQaProvider } from "./index.js";

type QaImageGenerationPatchInput = {
  providerMode: QaProviderMode;
  providerBaseUrl?: string;
  requiredPluginIds: readonly string[];
  existingPluginIds?: readonly string[];
  forcedRuntime?: RuntimeId;
};

function splitModelProviderId(modelRef: string) {
  const slash = modelRef.indexOf("/");
  return slash > 0 ? modelRef.slice(0, slash) : null;
}

function uniqueNonEmpty(values: readonly (string | null | undefined)[]) {
  return uniqueStrings(normalizeTrimmedStringList(values));
}

export function buildQaImageGenerationConfigPatch(input: QaImageGenerationPatchInput) {
  const provider = getQaProvider(input.providerMode);
  const usesOpenAiMockImageProvider = input.providerMode === "mock-openai";
  const imageModelRef = usesOpenAiMockImageProvider
    ? "openai/gpt-image-1"
    : provider.defaultImageGenerationModel({
        modelProviderIds: provider.defaultImageGenerationProviderIds,
      });
  if (!imageModelRef) {
    throw new Error(
      `QA provider "${input.providerMode}" does not expose an image generation model`,
    );
  }
  const imageProviderId = splitModelProviderId(imageModelRef);
  const modelPatch = (() => {
    if (provider.kind !== "mock") {
      return null;
    }
    if (!input.providerBaseUrl) {
      throw new Error(`QA provider "${input.providerMode}" requires a mock provider URL`);
    }
    const gatewayModels = provider.buildGatewayModels({
      providerBaseUrl: input.providerBaseUrl,
    });
    if (input.forcedRuntime !== "codex" || input.providerMode !== "mock-openai") {
      return gatewayModels;
    }
    const openAiCatalog = gatewayModels?.providers.openai;
    if (!openAiCatalog) {
      throw new Error("forced Codex mock image QA requires the OpenAI mock catalog");
    }
    return {
      mode: "merge" as const,
      providers: {
        openai: {
          ...openAiCatalog,
          baseUrl: QA_CODEX_OPENAI_CATALOG_BASE_URL,
          request: undefined,
          models: openAiCatalog.models.map((model) =>
            model.id === "gpt-image-1"
              ? Object.assign({}, model, { baseUrl: input.providerBaseUrl })
              : model,
          ),
        },
      },
    };
  })();
  const providerPluginIds = imageProviderId ? [imageProviderId] : [];
  const enabledPluginIds = uniqueNonEmpty(providerPluginIds);

  return {
    plugins: {
      allow: uniqueNonEmpty([
        ...QA_BASE_RUNTIME_PLUGIN_IDS,
        ...(input.existingPluginIds ?? []),
        ...enabledPluginIds,
        ...input.requiredPluginIds,
      ]),
      ...(enabledPluginIds.length > 0
        ? {
            entries: Object.fromEntries(
              enabledPluginIds.map((pluginId) => [pluginId, { enabled: true }]),
            ),
          }
        : {}),
    },
    ...(modelPatch
      ? {
          models: {
            mode: modelPatch.mode,
            providers: modelPatch.providers,
          },
        }
      : {}),
    agents: {
      defaults: {
        mediaModels: {
          image: {
            primary: imageModelRef,
          },
        },
      },
    },
  };
}

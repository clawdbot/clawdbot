import type { QaProviderMode } from "./index.js";
import { getQaProvider } from "./index.js";

type QaImageGenerationPatchInput = {
  providerMode: QaProviderMode;
  providerBaseUrl?: string;
  requiredPluginIds: readonly string[];
};

function splitModelProviderId(modelRef: string) {
  const slash = modelRef.indexOf("/");
  return slash > 0 ? modelRef.slice(0, slash) : null;
}

function uniqueNonEmpty(values: readonly (string | null | undefined)[]) {
  return [
    ...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value)),
  ];
}

export function buildQaImageGenerationConfigPatch(input: QaImageGenerationPatchInput) {
  const provider = getQaProvider(input.providerMode);
  const imageModelRef = provider.defaultImageGenerationModel({
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
    return provider.buildGatewayModels({
      providerBaseUrl: input.providerBaseUrl,
    });
  })();
  const providerPluginIds = provider.usesModelProviderPlugins ? [imageProviderId] : [];
  const enabledPluginIds = uniqueNonEmpty(providerPluginIds);

  return {
    plugins: {
      allow: uniqueNonEmpty(["memory-core", ...enabledPluginIds, ...input.requiredPluginIds]),
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
        imageGenerationModel: {
          primary: imageModelRef,
        },
      },
    },
  };
}

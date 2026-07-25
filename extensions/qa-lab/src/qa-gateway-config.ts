// Qa Lab helper module supports qa gateway config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  splitQaModelRef,
  type QaProviderMode,
} from "./model-selection.js";
import { getQaProvider } from "./providers/index.js";
import { DEFAULT_QA_PROVIDER_MODE } from "./providers/index.js";
import type { QaThinkingLevel } from "./qa-thinking.js";
import type { QaTransportGatewayConfig } from "./qa-transport.js";
import type { RuntimeId } from "./runtime-parity.js";

export { normalizeQaThinkingLevel, type QaThinkingLevel } from "./qa-thinking.js";

export const DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS = Object.freeze([
  "http://127.0.0.1:18789",
  "http://localhost:18789",
  "http://127.0.0.1:43124",
  "http://localhost:43124",
]);

export const QA_BASE_RUNTIME_PLUGIN_IDS = Object.freeze(["acpx", "memory-core"]);
export const QA_CODEX_OPENAI_CATALOG_BASE_URL = "https://api.openai.com/v1";
const QA_LAB_PLUGIN_ID = "qa-lab";

export function mergeQaControlUiAllowedOrigins(extraOrigins?: string[]) {
  const normalizedExtra = (extraOrigins ?? [])
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return uniqueStrings([...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS, ...normalizedExtra]);
}

function normalizeQaGatewayModelRef(input: string | undefined, fallback: string) {
  const model = input?.trim();
  return model && model.length > 0 ? model : fallback;
}

function remapQaMockModelRefForCodex(modelRef: string) {
  const split = splitQaModelRef(modelRef);
  return split?.provider === "mock-openai" ? `openai/${split.model}` : modelRef;
}

function buildQaModelSelection(primaryModel: string, alternateModel: string) {
  const fallbacks = alternateModel !== primaryModel ? [alternateModel] : undefined;
  return fallbacks ? { primary: primaryModel, fallbacks } : { primary: primaryModel };
}

export function buildQaGatewayConfig(params: {
  bind: "loopback" | "lan";
  gatewayPort: number;
  gatewayToken: string;
  providerBaseUrl?: string;
  workspaceDir: string;
  controlUiRoot?: string;
  controlUiAllowedOrigins?: string[];
  controlUiEnabled?: boolean;
  providerMode?: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
  imageGenerationModel?: string | null;
  enabledProviderIds?: string[];
  enabledPluginIds?: string[];
  transportPluginIds?: readonly string[];
  transportConfig?: QaTransportGatewayConfig;
  liveProviderConfigs?: Record<string, ModelProviderConfig>;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  forcedRuntime?: RuntimeId;
}): OpenClawConfig {
  const providerBaseUrl = params.providerBaseUrl ?? "http://127.0.0.1:44080/v1";
  const providerMode = normalizeQaProviderMode(params.providerMode ?? DEFAULT_QA_PROVIDER_MODE);
  const provider = getQaProvider(providerMode);
  const usesCodexMockAppServer = params.forcedRuntime === "codex" && providerMode === "mock-openai";
  const normalizedPrimaryModel = normalizeQaGatewayModelRef(
    params.primaryModel,
    defaultQaModelForMode(providerMode),
  );
  const normalizedAlternateModel = normalizeQaGatewayModelRef(
    params.alternateModel,
    defaultQaModelForMode(providerMode, { alternate: true }),
  );
  const primaryModel = usesCodexMockAppServer
    ? remapQaMockModelRefForCodex(normalizedPrimaryModel)
    : normalizedPrimaryModel;
  const alternateModel = usesCodexMockAppServer
    ? remapQaMockModelRefForCodex(normalizedAlternateModel)
    : normalizedAlternateModel;
  const modelProviderIds = [primaryModel, alternateModel]
    .map((ref) => splitQaModelRef(ref)?.provider)
    .filter((providerValue): providerValue is string => Boolean(providerValue));
  const imageGenerationModelRef =
    params.imageGenerationModel !== undefined
      ? params.imageGenerationModel
      : provider.defaultImageGenerationModel({ modelProviderIds });
  const selectedProviderIds =
    provider.usesModelProviderPlugins || usesCodexMockAppServer
      ? [
          ...new Set(
            [...(params.enabledProviderIds ?? []), ...modelProviderIds, imageGenerationModelRef]
              .map((value) =>
                typeof value === "string" ? (splitQaModelRef(value)?.provider ?? value) : null,
              )
              .filter((providerLocal): providerLocal is string => Boolean(providerLocal)),
          ),
        ]
      : [];
  const configuredPluginIds = uniqueStrings(
    (params.enabledPluginIds ?? [])
      .map((pluginId) => pluginId.trim())
      .filter((pluginId) => pluginId.length > 0),
  );
  const selectedPluginIds = usesCodexMockAppServer
    ? uniqueStrings([...configuredPluginIds, ...selectedProviderIds])
    : provider.usesModelProviderPlugins
      ? uniqueStrings(
          (params.enabledPluginIds?.length ?? 0) > 0 ? configuredPluginIds : selectedProviderIds,
        )
      : configuredPluginIds;
  const transportPluginIds = uniqueStrings(params.transportPluginIds ?? [])
    .map((pluginId) => pluginId.trim())
    .filter((pluginId) => pluginId.length > 0);
  const pluginEntries = Object.fromEntries(
    selectedPluginIds.map((pluginId) => [pluginId, { enabled: true }]),
  );
  const transportPluginEntries = Object.fromEntries(
    transportPluginIds.map((pluginId) => [pluginId, { enabled: true }]),
  );
  const allowedPlugins = [
    ...new Set([
      ...QA_BASE_RUNTIME_PLUGIN_IDS,
      QA_LAB_PLUGIN_ID,
      ...selectedPluginIds,
      ...transportPluginIds,
    ]),
  ];
  const resolveModelEntry = (modelRef: string) => {
    // Codex owns its app-server transport. OpenClaw provider params would make
    // the forced parity cell an authored route that Codex correctly rejects.
    if (params.forcedRuntime === "codex") {
      return {};
    }
    return {
      params: provider.resolveModelParams({
        modelRef,
        fastMode: params.fastMode,
        thinkingDefault: params.thinkingDefault,
      }),
    };
  };
  const allowedOrigins = mergeQaControlUiAllowedOrigins(params.controlUiAllowedOrigins);
  const providerGatewayModels = provider.buildGatewayModels({
    providerBaseUrl,
    primaryModel,
    alternateModel,
    liveProviderConfigs: params.liveProviderConfigs,
  });
  const codexMockOpenAiCatalog = providerGatewayModels?.providers.openai;
  const gatewayModels =
    usesCodexMockAppServer && codexMockOpenAiCatalog
      ? {
          mode: "merge" as const,
          providers: {
            openai: {
              ...codexMockOpenAiCatalog,
              // Keep synthetic QA model ids registered without authoring the
              // private mock route that the Codex harness cannot reproduce.
              baseUrl: QA_CODEX_OPENAI_CATALOG_BASE_URL,
              request: undefined,
            },
          },
        }
      : providerGatewayModels;
  const mockMemorySearch =
    provider.kind === "mock"
      ? {
          provider: "openai",
          model: "text-embedding-3-small",
          remote: {
            // Memory embeddings bypass the model runtime, so bind them to the
            // mock explicitly or a forced runtime can fall through to a live API.
            baseUrl: providerBaseUrl,
            apiKey: "test",
          },
        }
      : {};

  return {
    memory: {
      backend: "builtin",
      search: {
        ...mockMemorySearch,
      },
    },
    plugins: {
      allow: allowedPlugins,
      slots: {
        memory: "memory-core",
      },
      entries: {
        acpx: {
          enabled: true,
          config: {
            pluginToolsMcpBridge: true,
            openClawToolsMcpBridge: true,
          },
        },
        "memory-core": {
          enabled: true,
        },
        [QA_LAB_PLUGIN_ID]: {
          enabled: true,
        },
        ...pluginEntries,
        ...transportPluginEntries,
      },
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: buildQaModelSelection(primaryModel, alternateModel),
        ...(imageGenerationModelRef
          ? {
              mediaModels: {
                image: { primary: imageGenerationModelRef },
              },
            }
          : {}),
        ...(params.thinkingDefault ? { thinkingDefault: params.thinkingDefault } : {}),
        models: {
          [primaryModel]: resolveModelEntry(primaryModel),
          [alternateModel]: resolveModelEntry(alternateModel),
        },
        subagents: {
          allowAgents: ["*"],
          maxConcurrent: 2,
        },
      },
      entries: {
        qa: {
          default: true,
          model: buildQaModelSelection(primaryModel, alternateModel),
          ...(params.forcedRuntime === "codex" && params.fastMode !== undefined
            ? { fastModeDefault: params.fastMode }
            : {}),
          identity: {
            name: "C-3PO QA",
            theme: "Flustered Protocol Droid",
            emoji: "🤖",
            avatar: "avatars/c3po.png",
          },
          subagents: {
            allowAgents: ["*"],
          },
          tools: {
            profile: "coding",
          },
        },
      },
    },
    tools: {
      // The parity scenarios are code-agent contracts: they must always expose
      // file, image, memory, and subagent tools even when the surrounding
      // environment defaults to a messaging-only profile.
      profile: "coding",
    },
    ...(gatewayModels
      ? {
          models: {
            mode: gatewayModels.mode,
            providers: gatewayModels.providers,
          },
        }
      : {}),
    gateway: {
      mode: "local",
      bind: params.bind,
      port: params.gatewayPort,
      auth: {
        mode: "token",
        token: params.gatewayToken,
      },
      controlUi: {
        enabled: params.controlUiEnabled ?? true,
        ...((params.controlUiEnabled ?? true) && params.controlUiRoot
          ? { root: params.controlUiRoot }
          : {}),
        ...((params.controlUiEnabled ?? true)
          ? {
              allowedOrigins,
            }
          : {}),
      },
    },
    discovery: {
      mdns: {
        mode: "off",
      },
    },
    ...(params.transportConfig?.channels ? { channels: params.transportConfig.channels } : {}),
    ...(params.transportConfig?.messages ? { messages: params.transportConfig.messages } : {}),
  } satisfies OpenClawConfig;
}

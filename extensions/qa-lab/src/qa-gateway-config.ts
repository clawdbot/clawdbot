import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  splitQaModelRef,
  type QaProviderMode,
} from "./model-selection.js";
import { getQaProvider } from "./providers/index.js";
import { DEFAULT_QA_PROVIDER_MODE } from "./providers/index.js";
import { normalizeQaThinkingLevel, type QaThinkingLevel } from "./qa-thinking.js";
import type { QaTransportGatewayConfig } from "./qa-transport.js";

export { normalizeQaThinkingLevel, type QaThinkingLevel } from "./qa-thinking.js";

export const DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS = Object.freeze([
  "http://127.0.0.1:18789",
  "http://localhost:18789",
  "http://127.0.0.1:43124",
  "http://localhost:43124",
]);

export const QA_BASE_RUNTIME_PLUGIN_IDS = Object.freeze(["acpx", "memory-core"]);

export function mergeQaControlUiAllowedOrigins(extraOrigins?: string[]) {
  const normalizedExtra = (extraOrigins ?? [])
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return [...new Set([...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS, ...normalizedExtra])];
}

function normalizeQaGatewayModelRef(input: string | undefined, fallback: string) {
  const model = input?.trim();
  return model && model.length > 0 ? model : fallback;
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
}): OpenClawConfig {
  const providerBaseUrl = params.providerBaseUrl ?? "http://127.0.0.1:44080/v1";
  const providerMode = normalizeQaProviderMode(params.providerMode ?? DEFAULT_QA_PROVIDER_MODE);
  const provider = getQaProvider(providerMode);
  const primaryModel = normalizeQaGatewayModelRef(
    params.primaryModel,
    defaultQaModelForMode(providerMode),
  );
  const alternateModel = normalizeQaGatewayModelRef(
    params.alternateModel,
    defaultQaModelForMode(providerMode, { alternate: true }),
  );
  const modelProviderIds = [primaryModel, alternateModel]
    .map((ref) => splitQaModelRef(ref)?.provider)
    .filter((provider): provider is string => Boolean(provider));
  const imageGenerationModelRef =
    params.imageGenerationModel !== undefined
      ? params.imageGenerationModel
      : provider.defaultImageGenerationModel({ modelProviderIds });
  const selectedProviderIds = provider.usesModelProviderPlugins
    ? [
        ...new Set(
          [...(params.enabledProviderIds ?? []), ...modelProviderIds, imageGenerationModelRef]
            .map((value) =>
              typeof value === "string" ? (splitQaModelRef(value)?.provider ?? value) : null,
            )
            .filter((provider): provider is string => Boolean(provider)),
        ),
      ]
    : [];
  const selectedPluginIds = provider.usesModelProviderPlugins
    ? [
        ...new Set(
          (params.enabledPluginIds?.length ?? 0) > 0
            ? params.enabledPluginIds
            : selectedProviderIds,
        ),
      ]
    : [
        ...new Set(
          (params.enabledPluginIds ?? [])
            .map((pluginId) => pluginId.trim())
            .filter((pluginId) => pluginId.length > 0),
        ),
      ];
  const transportPluginIds = [...new Set(params.transportPluginIds ?? [])]
    .map((pluginId) => pluginId.trim())
    .filter((pluginId) => pluginId.length > 0);
  const pluginEntries = Object.fromEntries(
    selectedPluginIds.map((pluginId) => [pluginId, { enabled: true }]),
  );
  const transportPluginEntries = Object.fromEntries(
    transportPluginIds.map((pluginId) => [pluginId, { enabled: true }]),
  );
  const allowedPlugins = [
    ...new Set([...QA_BASE_RUNTIME_PLUGIN_IDS, ...selectedPluginIds, ...transportPluginIds]),
  ];
  const resolveModelParams = (modelRef: string) =>
    provider.resolveModelParams({
      modelRef,
      fastMode: params.fastMode,
      thinkingDefault: params.thinkingDefault,
    });
  const allowedOrigins = mergeQaControlUiAllowedOrigins(params.controlUiAllowedOrigins);
  const gatewayModels = provider.buildGatewayModels({
    providerBaseUrl,
    liveProviderConfigs: params.liveProviderConfigs,
  });

  return {
    plugins: {
      allow: allowedPlugins,
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
        ...pluginEntries,
        ...transportPluginEntries,
      },
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: {
          primary: primaryModel,
        },
        ...(imageGenerationModelRef
          ? {
              imageGenerationModel: {
                primary: imageGenerationModelRef,
              },
            }
          : {}),
        ...(params.thinkingDefault ? { thinkingDefault: params.thinkingDefault } : {}),
        memorySearch: {
          sync: {
            watch: true,
            watchDebounceMs: 25,
            onSessionStart: true,
            onSearch: true,
          },
        },
        models: {
          [primaryModel]: {
            params: resolveModelParams(primaryModel),
          },
          [alternateModel]: {
            params: resolveModelParams(alternateModel),
          },
        },
        subagents: {
          allowAgents: ["*"],
          maxConcurrent: 2,
        },
      },
      list: [
        {
          id: "qa",
          default: true,
          model: {
            primary: primaryModel,
          },
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
      ],
    },
    memory: {
      backend: "builtin",
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
      reload: {
        // QA restart scenarios need deterministic reload timing instead of the
        // much longer production deferral window.
        deferralTimeoutMs: 1_000,
      },
      controlUi: {
        enabled: params.controlUiEnabled ?? true,
        ...((params.controlUiEnabled ?? true) && params.controlUiRoot
          ? { root: params.controlUiRoot }
          : {}),
        ...((params.controlUiEnabled ?? true)
          ? {
              allowInsecureAuth: true,
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

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  defaultQaModelForMode,
  isQaFastModeModelRef,
  normalizeQaProviderMode,
  splitQaModelRef,
  type QaProviderMode,
} from "./model-selection.js";

export const DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS = Object.freeze([
  "http://127.0.0.1:18789",
  "http://localhost:18789",
  "http://127.0.0.1:43124",
  "http://localhost:43124",
]);

export type QaThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";

export function normalizeQaThinkingLevel(input: unknown): QaThinkingLevel | undefined {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  const collapsed = value.replace(/[\s_-]+/g, "");
  if (collapsed === "off") {
    return "off";
  }
  if (collapsed === "minimal" || collapsed === "min") {
    return "minimal";
  }
  if (collapsed === "low") {
    return "low";
  }
  if (collapsed === "medium" || collapsed === "med") {
    return "medium";
  }
  if (collapsed === "high") {
    return "high";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  return undefined;
}

export function mergeQaControlUiAllowedOrigins(extraOrigins?: string[]) {
  const normalizedExtra = (extraOrigins ?? [])
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return [...new Set([...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS, ...normalizedExtra])];
}

export function buildQaGatewayConfig(params: {
  bind: "loopback" | "lan";
  gatewayPort: number;
  gatewayToken: string;
  providerBaseUrl?: string;
  qaBusBaseUrl: string;
  includeQaChannel?: boolean;
  workspaceDir: string;
  controlUiRoot?: string;
  controlUiAllowedOrigins?: string[];
  controlUiEnabled?: boolean;
  providerMode?: QaProviderMode | "live-openai";
  primaryModel?: string;
  alternateModel?: string;
  imageGenerationModel?: string | null;
  enabledProviderIds?: string[];
  enabledPluginIds?: string[];
  liveProviderConfigs?: Record<string, ModelProviderConfig>;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
}): OpenClawConfig {
  const includeQaChannel = params.includeQaChannel !== false;
  const mockProviderBaseUrl = params.providerBaseUrl ?? "http://127.0.0.1:44080/v1";
  const mockOpenAiProvider: ModelProviderConfig = {
    baseUrl: mockProviderBaseUrl,
    apiKey: "test",
    api: "openai-responses",
    models: [
      {
        id: "gpt-5.4",
        name: "gpt-5.4",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "gpt-5.4-alt",
        name: "gpt-5.4-alt",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
      {
        id: "gpt-image-1",
        name: "gpt-image-1",
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  };
  const providerMode = normalizeQaProviderMode(params.providerMode ?? "mock-openai");
  const primaryModel = params.primaryModel ?? defaultQaModelForMode(providerMode);
  const alternateModel =
    params.alternateModel ?? defaultQaModelForMode(providerMode, { alternate: true });
  const modelProviderIds = [primaryModel, alternateModel]
    .map((ref) => splitQaModelRef(ref)?.provider)
    .filter((provider): provider is string => Boolean(provider));
  const imageGenerationModelRef =
    params.imageGenerationModel !== undefined
      ? params.imageGenerationModel
      : providerMode === "mock-openai"
        ? "mock-openai/gpt-image-1"
        : modelProviderIds.includes("openai")
          ? "openai/gpt-image-1"
          : null;
  const selectedProviderIds =
    providerMode === "live-frontier"
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
  const selectedPluginIds =
    providerMode === "live-frontier"
      ? [
          ...new Set(
            (params.enabledPluginIds?.length ?? 0) > 0
              ? params.enabledPluginIds
              : selectedProviderIds,
          ),
        ]
      : [];
  const pluginEntries =
    providerMode === "live-frontier"
      ? Object.fromEntries(selectedPluginIds.map((pluginId) => [pluginId, { enabled: true }]))
      : {};
  const allowedPlugins =
    providerMode === "live-frontier"
      ? ["memory-core", ...selectedPluginIds, ...(includeQaChannel ? ["qa-channel"] : [])]
      : ["memory-core", ...(includeQaChannel ? ["qa-channel"] : [])];
  const liveModelParams =
    providerMode === "live-frontier"
      ? (modelRef: string) => ({
          transport: "sse",
          openaiWsWarmup: false,
          ...(params.fastMode === true || isQaFastModeModelRef(modelRef) ? { fastMode: true } : {}),
          ...(params.thinkingDefault ? { thinking: params.thinkingDefault } : {}),
        })
      : (_modelRef: string) => ({
          transport: "sse",
          openaiWsWarmup: false,
        });
  const allowedOrigins = mergeQaControlUiAllowedOrigins(params.controlUiAllowedOrigins);
  const liveProviderConfigs =
    providerMode === "live-frontier" ? (params.liveProviderConfigs ?? {}) : {};
  const hasLiveProviderConfigs = Object.keys(liveProviderConfigs).length > 0;

  return {
    plugins: {
      allow: allowedPlugins,
      entries: {
        acpx: {
          enabled: false,
        },
        "memory-core": {
          enabled: true,
        },
        ...pluginEntries,
        ...(includeQaChannel ? { "qa-channel": { enabled: true } } : {}),
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
            params: liveModelParams(primaryModel),
          },
          [alternateModel]: {
            params: liveModelParams(alternateModel),
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
        },
      ],
    },
    memory: {
      backend: "builtin",
    },
    ...(providerMode === "mock-openai"
      ? {
          models: {
            mode: "replace",
            providers: {
              "mock-openai": mockOpenAiProvider,
            },
          },
        }
      : hasLiveProviderConfigs
        ? {
            models: {
              mode: "merge",
              providers: liveProviderConfigs,
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
    ...(includeQaChannel
      ? {
          channels: {
            "qa-channel": {
              enabled: true,
              baseUrl: params.qaBusBaseUrl,
              botUserId: "openclaw",
              botDisplayName: "OpenClaw QA",
              allowFrom: ["*"],
              pollTimeoutMs: 250,
            },
          },
        }
      : {}),
    messages: {
      groupChat: {
        mentionPatterns: ["\\b@?openclaw\\b"],
      },
    },
  } satisfies OpenClawConfig;
}

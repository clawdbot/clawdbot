// Qa Lab plugin module implements live gateway behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  startQaGatewayChild,
  type QaCliBackendAuthMode,
  type QaGatewayChildCommand,
} from "../../gateway-child.js";
import type { QaProviderMode } from "../../model-selection.js";
import { startQaProviderServer } from "../../providers/server-runtime.js";
import type { QaThinkingLevel } from "../../qa-gateway-config.js";
import type { RuntimeId } from "../../runtime-parity.js";
import { appendQaLiveLaneIssue as appendLiveLaneIssue } from "./live-artifacts.js";

async function stopQaLiveLaneResources(
  resources: {
    gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | null;
    mock: { baseUrl: string; stop(): Promise<void> } | null;
  },
  opts?: { keepTemp?: boolean; preserveToDir?: string },
) {
  const errors: string[] = [];
  if (resources.gateway) {
    try {
      await resources.gateway.stop(opts);
      resources.gateway = null;
    } catch (error) {
      appendLiveLaneIssue(errors, "gateway stop failed", error);
    }
  }
  if (resources.mock) {
    try {
      await resources.mock.stop();
      resources.mock = null;
    } catch (error) {
      appendLiveLaneIssue(errors, "mock provider stop failed", error);
    }
  }
  if (errors.length > 0) {
    throw new Error(`failed to stop QA live lane resources:\n${errors.join("\n")}`);
  }
}

function omitMemoryCoreEntry<T extends Record<string, unknown> | undefined>(entries: T): T {
  if (!entries || !Object.hasOwn(entries, "memory-core")) {
    return entries;
  }
  const { "memory-core": _memoryCore, ...rest } = entries;
  return rest as T;
}

function prepareLiveTransportGatewayConfig(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    plugins: cfg.plugins
      ? {
          ...cfg.plugins,
          allow: cfg.plugins.allow?.filter((pluginId) => pluginId !== "memory-core"),
          entries: omitMemoryCoreEntry(cfg.plugins.entries),
          slots: {
            ...cfg.plugins.slots,
            memory: "none",
          },
        }
      : {
          slots: {
            memory: "none",
          },
        },
    memory: {
      ...cfg.memory,
      search: {
        ...cfg.memory?.search,
        enabled: false,
      },
    },
  };
}

export async function startQaLiveLaneGateway(params: {
  repoRoot: string;
  command?: QaGatewayChildCommand;
  transport: {
    requiredPluginIds: readonly string[];
    createGatewayConfig: (params: {
      baseUrl: string;
    }) => Pick<OpenClawConfig, "channels" | "messages">;
  };
  transportBaseUrl: string;
  controlUiAllowedOrigins?: string[];
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  forcedRuntime?: RuntimeId;
  thinkingDefault?: QaThinkingLevel;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  controlUiEnabled?: boolean;
  mockAuthAgentIds?: readonly string[];
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}) {
  const mock = await startQaProviderServer(params.providerMode, {
    modelRefs: [params.primaryModel, params.alternateModel],
  });
  try {
    const gateway = await startQaGatewayChild({
      repoRoot: params.repoRoot,
      command: params.command,
      providerBaseUrl: mock ? `${mock.baseUrl}/v1` : undefined,
      transport: params.transport,
      transportBaseUrl: params.transportBaseUrl,
      controlUiAllowedOrigins: params.controlUiAllowedOrigins,
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
      fastMode: params.fastMode,
      forcedRuntime: params.forcedRuntime,
      thinkingDefault: params.thinkingDefault,
      claudeCliAuthMode: params.claudeCliAuthMode,
      controlUiEnabled: params.controlUiEnabled,
      mockAuthAgentIds: params.mockAuthAgentIds,
      mutateConfig: (cfg) =>
        prepareLiveTransportGatewayConfig(params.mutateConfig ? params.mutateConfig(cfg) : cfg),
    });
    const resources = { gateway, mock };
    return {
      gateway,
      mock,
      async stop(opts?: { keepTemp?: boolean; preserveToDir?: string }) {
        await stopQaLiveLaneResources(resources, opts);
      },
    };
  } catch (error) {
    if (mock) {
      try {
        await mock.stop();
      } catch (cleanupError) {
        const errors: string[] = [];
        appendLiveLaneIssue(errors, "gateway startup failed", error);
        appendLiveLaneIssue(errors, "mock provider stop failed", cleanupError);
        throw new Error(`failed to start QA live lane gateway:\n${errors.join("\n")}`, {
          cause: cleanupError,
        });
      }
    }
    throw error;
  }
}

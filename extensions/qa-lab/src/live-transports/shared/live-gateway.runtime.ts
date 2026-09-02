import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createQaGatewayChild,
  type QaGatewayChild,
  type QaGatewayStopResult,
  type QaGatewayStopOptions,
  type QaCliBackendAuthMode,
  type QaGatewayChildCommand,
} from "../../gateway-child.js";
import type { QaProviderMode } from "../../model-selection.js";
import { startQaProviderServer } from "../../providers/server-runtime.js";
import type { QaThinkingLevel } from "../../qa-gateway-config.js";
import type { RuntimeId } from "../../runtime-parity.js";

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

type QaLiveGatewayParams = {
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
};

type QaLiveGateway = {
  gateway: QaGatewayChild;
  mock: Awaited<ReturnType<typeof startQaProviderServer>>;
  stop: (opts?: QaGatewayStopOptions) => Promise<void>;
};

export function createQaLiveLaneGateway() {
  const gatewayOwner = createQaGatewayChild();
  let mock: Awaited<ReturnType<typeof startQaProviderServer>> = null;
  let startup: Promise<QaLiveGateway> | undefined;
  let stopping: Promise<QaGatewayStopResult> | undefined;
  let closed = false;
  const stop = (opts?: QaGatewayStopOptions) => {
    closed = true;
    stopping ??= (async () => {
      // Close child admission before waiting for provider startup; an awaited
      // provider must not transfer a new Gateway into an already stopped lane.
      const childStop = gatewayOwner.stop(opts);
      await startup?.catch(() => {});
      const result = await childStop;
      const errors = [...result.errors];
      try {
        await mock?.stop();
        mock = null;
      } catch (error) {
        errors.push(error);
      }
      return { process: result.process, errors };
    })();
    const current = stopping;
    void current.then((result) => {
      if (result.errors.length) {
        stopping = undefined;
      }
    });
    return current;
  };
  const stopReady = async (opts?: QaGatewayStopOptions) => {
    const result = await stop(opts);
    if (result.errors.length) {
      throw new AggregateError(
        result.errors,
        `failed to stop QA live lane resources: ${result.errors.map(formatErrorMessage).join("; ")}`,
      );
    }
  };
  return {
    stop,
    start(params: QaLiveGatewayParams) {
      if (closed || startup) {
        throw new Error("qa live gateway lifecycle already started or closed");
      }
      startup = (async () => {
        mock = await startQaProviderServer(params.providerMode, {
          modelRefs: [params.primaryModel, params.alternateModel],
        });
        if (closed) {
          throw new Error("qa live gateway lifecycle is closed");
        }
        const gateway = await gatewayOwner.start({
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

        return { gateway, mock, stop: stopReady };
      })();
      return startup;
    },
  };
}

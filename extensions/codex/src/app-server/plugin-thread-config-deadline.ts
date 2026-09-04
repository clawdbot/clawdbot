import {
  AgentHarnessPreflightError,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
/** Enforces one bounded startup budget across Codex plugin config discovery. */
import {
  defaultCodexAppInventoryCache,
  type CodexAppInventoryCache,
} from "./app-inventory-cache.js";
import type { CodexAppServerClient } from "./client.js";
import {
  resolveCodexPluginsPolicy,
  type CodexPluginConfig,
  type ResolvedCodexPluginsPolicy,
} from "./config.js";
import { disableCodexPluginThreadConfig } from "./dynamic-tool-build.js";
import {
  resolveRecoverableCodexPluginConfigKeys,
  type CodexPluginRuntimeRequest,
} from "./plugin-inventory.js";
import {
  defaultCodexPluginMetadataCache,
  type CodexPluginMetadataCache,
} from "./plugin-metadata-cache.js";
import {
  buildCodexPluginThreadConfig,
  buildCodexPluginThreadConfigTimeoutFallback,
  shouldBuildCodexPluginThreadConfig,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import {
  intersectCodexPluginThreadConfigWithScheduledAuthority,
  readCurrentCodexScheduledAppPolicy as readCurrentCodexScheduledAppPolicyShared,
} from "./scheduled-app-authority.js";
import type { CurrentCodexScheduledAppPolicy } from "./scheduled-app-authority.js";
import { withAbortableTimeout } from "./timeout.js";

const CODEX_PLUGIN_THREAD_CONFIG_MAX_TIMEOUT_MS = 60_000;
const CODEX_PLUGIN_THREAD_CONFIG_TIMEOUT_DIVISOR = 4;
const CODEX_PLUGIN_THREAD_CONFIG_MIN_TIMEOUT_MS = 100;

type CodexPluginThreadConfigDeadlineRequest = (
  method: string,
  params: unknown,
  options: { timeoutMs: number; signal: AbortSignal },
) => Promise<unknown>;

type BuildCodexPluginThreadConfigWithinDeadlineParams = Omit<
  Parameters<typeof buildCodexPluginThreadConfig>[0],
  "request"
> & {
  requestTimeoutMs: number;
  signal: AbortSignal;
  request: CodexPluginThreadConfigDeadlineRequest;
  failClosedOnTimeout?: boolean;
  transform?: (
    config: CodexPluginThreadConfig,
    request: CodexPluginRuntimeRequest,
  ) => Promise<CodexPluginThreadConfig>;
};

class CodexPluginThreadConfigDeadlineError extends Error {
  constructor() {
    super("Codex plugin thread config deadline elapsed");
    this.name = "CodexPluginThreadConfigDeadlineError";
  }
}

/** Resolves the plugin policy state reused throughout app-server startup. */
export function resolveCodexPluginThreadConfigStartupPolicy(params: {
  pluginConfig: CodexPluginConfig;
  nativeToolSurfaceEnabled: boolean;
  scheduledRuntimeAuthority?: EmbeddedRunAttemptParams["scheduledRuntimeAuthority"];
}) {
  const pluginThreadConfigRequired =
    Boolean(params.scheduledRuntimeAuthority) ||
    !params.nativeToolSurfaceEnabled ||
    shouldBuildCodexPluginThreadConfig(params.pluginConfig);
  // Restricted runs disable the native apps feature without inventory discovery.
  const pluginThreadConfigPluginConfig =
    params.nativeToolSurfaceEnabled || params.scheduledRuntimeAuthority
      ? params.pluginConfig
      : disableCodexPluginThreadConfig(params.pluginConfig);
  const resolvedPluginPolicy = pluginThreadConfigRequired
    ? resolveCodexPluginsPolicy(pluginThreadConfigPluginConfig)
    : undefined;
  return {
    pluginThreadConfigRequired,
    pluginThreadConfigPluginConfig,
    resolvedPluginPolicy,
    enabledPluginConfigKeys: resolvedPluginPolicy
      ? resolvedPluginPolicy.pluginPolicies
          .filter((plugin) => plugin.enabled)
          .map((plugin) => plugin.configKey)
          .toSorted()
      : undefined,
  };
}

/** Builds plugin config without allowing sequential RPC timeouts to consume the turn. */
async function buildCodexPluginThreadConfigWithinDeadline(
  params: BuildCodexPluginThreadConfigWithinDeadlineParams,
): Promise<CodexPluginThreadConfig> {
  const { requestTimeoutMs, signal, request, failClosedOnTimeout, transform, ...buildParams } =
    params;
  signal.throwIfAborted();
  const timeoutMs = resolveCodexPluginThreadConfigTimeoutMs(requestTimeoutMs);
  // One deadline owns the whole config build; every RPC gets only the remaining
  // budget so discovery cannot consume one full request timeout per call.
  const deadlineMs = Date.now() + timeoutMs;
  const boundedRequest: CodexPluginRuntimeRequest = (method, requestParams) => {
    const remainingTimeoutMs = deadlineMs - Date.now();
    if (remainingTimeoutMs <= 0) {
      throw new CodexPluginThreadConfigDeadlineError();
    }
    return request(method, requestParams, {
      timeoutMs: remainingTimeoutMs,
      signal,
    });
  };
  try {
    return await withAbortableTimeout({
      signal,
      timeoutMs,
      promise: (async () => {
        const config = await buildCodexPluginThreadConfig({
          ...buildParams,
          request: boundedRequest,
        });
        const result = transform ? await transform(config, boundedRequest) : config;
        // Inventory readers can absorb an RPC timeout into an unavailable result.
        if (Date.now() >= deadlineMs) {
          throw new CodexPluginThreadConfigDeadlineError();
        }
        return result;
      })(),
      timeoutMessage: "Codex plugin thread config deadline elapsed",
      createTimeoutError: () => new CodexPluginThreadConfigDeadlineError(),
    });
  } catch (error) {
    if (
      signal.aborted ||
      (!isCodexPluginThreadConfigTimeoutError(error) && Date.now() < deadlineMs)
    ) {
      throw error;
    }
    if (failClosedOnTimeout) {
      throw new AgentHarnessPreflightError(
        `Codex app policy verification exceeded its ${timeoutMs} ms startup budget. No app tools were executed. Retry after Codex app inventory is responsive.`,
      );
    }
    return buildCodexPluginThreadConfigTimeoutFallback({
      pluginConfig: buildParams.pluginConfig,
      appCacheKey: buildParams.appCacheKey,
      message: `Codex plugin discovery exceeded its ${timeoutMs} ms startup budget; plugin apps were disabled for this turn.`,
    });
  }
}

/** Creates the recovery metadata and bounded builder used by thread startup. */
export function createCodexPluginThreadConfigStartupProvider(params: {
  inputFingerprint: string | undefined;
  enabledPluginConfigKeys: string[] | undefined;
  policy: ResolvedCodexPluginsPolicy | undefined;
  requestTimeoutMs: number;
  signal: AbortSignal;
  pluginConfig?: unknown;
  client: Pick<CodexAppServerClient, "request">;
  configCwd?: string;
  appCache?: CodexAppInventoryCache;
  appCacheKey: string;
  metadataCache?: CodexPluginMetadataCache;
  scheduledRuntimeAuthority?: EmbeddedRunAttemptParams["scheduledRuntimeAuthority"];
}) {
  const {
    client,
    policy,
    inputFingerprint,
    enabledPluginConfigKeys,
    appCache,
    metadataCache: configuredMetadataCache,
    ...buildParams
  } = params;
  const metadataCache = configuredMetadataCache ?? defaultCodexPluginMetadataCache;
  return {
    enabled: true,
    // The bound context stores admitted apps only; native config owns excluded
    // app IDs and tool/link overrides that can change between turns.
    requiresCurrentPolicyCheck: Boolean(policy?.enabled || params.scheduledRuntimeAuthority),
    inputFingerprint,
    enabledPluginConfigKeys,
    accountAppRecoveryEnabled: policy?.allowAllPlugins,
    recoverablePluginConfigKeys: policy
      ? resolveRecoverableCodexPluginConfigKeys({
          policy,
          metadataCache,
          appCacheKey: params.appCacheKey,
          configCwd: params.configCwd,
        })
      : undefined,
    build: async (buildOptions?: { threadId?: string }) => {
      const config = await buildCodexPluginThreadConfigWithinDeadline({
        ...buildParams,
        threadId: buildOptions?.threadId,
        appCache: appCache ?? defaultCodexAppInventoryCache,
        metadataCache,
        failClosedOnTimeout: Boolean(params.scheduledRuntimeAuthority),
        transform: params.scheduledRuntimeAuthority
          ? async (builtConfig, request) =>
              intersectCodexPluginThreadConfigWithScheduledAuthority(
                builtConfig,
                params.scheduledRuntimeAuthority,
                await readCurrentCodexScheduledAppPolicy(
                  request,
                  params.configCwd,
                  buildOptions?.threadId,
                ),
              )
          : undefined,
        request: (method, requestParams, options) => client.request(method, requestParams, options),
      });
      return params.scheduledRuntimeAuthority && params.inputFingerprint
        ? { ...config, inputFingerprint: params.inputFingerprint }
        : config;
    },
  };
}

async function readCurrentCodexScheduledAppPolicy(
  request: CodexPluginRuntimeRequest,
  cwd: string | undefined,
  threadId: string | undefined,
): Promise<CurrentCodexScheduledAppPolicy> {
  return await readCurrentCodexScheduledAppPolicyShared({
    request,
    configCwd: cwd,
    threadId,
  });
}

function resolveCodexPluginThreadConfigTimeoutMs(requestTimeoutMs: number): number {
  const finiteRequestTimeoutMs =
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : CODEX_PLUGIN_THREAD_CONFIG_MAX_TIMEOUT_MS * CODEX_PLUGIN_THREAD_CONFIG_TIMEOUT_DIVISOR;
  return Math.min(
    CODEX_PLUGIN_THREAD_CONFIG_MAX_TIMEOUT_MS,
    Math.max(
      CODEX_PLUGIN_THREAD_CONFIG_MIN_TIMEOUT_MS,
      Math.floor(finiteRequestTimeoutMs / CODEX_PLUGIN_THREAD_CONFIG_TIMEOUT_DIVISOR),
    ),
  );
}

function isCodexPluginThreadConfigTimeoutError(error: unknown): boolean {
  return (
    error instanceof CodexPluginThreadConfigDeadlineError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED" &&
      error.message.endsWith(" timed out"))
  );
}

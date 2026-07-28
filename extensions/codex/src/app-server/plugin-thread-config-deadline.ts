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
import { resolveRecoverableCodexPluginConfigKeys } from "./plugin-inventory.js";
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
}) {
  const pluginThreadConfigRequired =
    !params.nativeToolSurfaceEnabled || shouldBuildCodexPluginThreadConfig(params.pluginConfig);
  // Restricted runs still need a config so thread/start carries an explicit
  // apps._default denial patch without app/list discovery.
  const pluginThreadConfigPluginConfig = params.nativeToolSurfaceEnabled
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
  const { requestTimeoutMs, signal, request, ...buildParams } = params;
  const timeoutMs = resolveCodexPluginThreadConfigTimeoutMs(requestTimeoutMs);
  // One deadline owns the whole config build; every RPC gets only the remaining
  // budget so discovery cannot consume one full request timeout per call.
  const deadlineMs = Date.now() + timeoutMs;
  try {
    return await waitForCodexPluginThreadConfigBuild({
      signal,
      timeoutMs,
      build: () =>
        buildCodexPluginThreadConfig({
          ...buildParams,
          request: (method, requestParams) => {
            const remainingTimeoutMs = deadlineMs - Date.now();
            if (remainingTimeoutMs <= 0) {
              throw new CodexPluginThreadConfigDeadlineError();
            }
            return request(method, requestParams, {
              timeoutMs: remainingTimeoutMs,
              signal,
            });
          },
        }),
    });
  } catch (error) {
    if (signal.aborted || !isCodexPluginThreadConfigTimeoutError(error)) {
      throw error;
    }
    return buildCodexPluginThreadConfigTimeoutFallback({
      pluginConfig: buildParams.pluginConfig,
      appCacheKey: buildParams.appCacheKey,
      message: `Codex plugin discovery exceeded its ${timeoutMs} ms startup budget; plugin apps were disabled for this turn.`,
    });
  }
}

function waitForCodexPluginThreadConfigBuild(params: {
  signal: AbortSignal;
  timeoutMs: number;
  build: () => Promise<CodexPluginThreadConfig>;
}): Promise<CodexPluginThreadConfig> {
  if (params.signal.aborted) {
    return Promise.reject(resolveAbortReason(params.signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(timer);
      params.signal.removeEventListener("abort", onAbort);
      return true;
    };
    const resolveOnce = (config: CodexPluginThreadConfig) => {
      if (finish()) {
        resolve(config);
      }
    };
    const rejectOnce = (error: unknown) => {
      if (finish()) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onAbort = () => rejectOnce(resolveAbortReason(params.signal));
    const timer = setTimeout(
      () => rejectOnce(new CodexPluginThreadConfigDeadlineError()),
      params.timeoutMs,
    );
    params.signal.addEventListener("abort", onAbort, { once: true });
    params.build().then(resolveOnce, rejectOnce);
  });
}

function resolveAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex plugin thread config aborted");
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
    inputFingerprint,
    enabledPluginConfigKeys,
    accountAppRecoveryEnabled: policy?.allowAllPlugins,
    recoverablePluginConfigKeys: policy
      ? resolveRecoverableCodexPluginConfigKeys({
          policy,
          metadataCache,
          appCacheKey: params.appCacheKey,
        })
      : undefined,
    build: () =>
      buildCodexPluginThreadConfigWithinDeadline({
        ...buildParams,
        appCache: appCache ?? defaultCodexAppInventoryCache,
        metadataCache,
        request: (method, requestParams, options) => client.request(method, requestParams, options),
      }),
  };
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

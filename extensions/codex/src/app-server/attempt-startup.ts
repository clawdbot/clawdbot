/**
 * Startup orchestration for Codex app-server attempts, including shared-client
 * leasing, plugin thread config, sandbox execution environment, and thread
 * lifecycle binding.
 */
import {
  embeddedAgentLog,
  formatErrorMessage,
  type CodexBundleMcpThreadConfig,
  type EmbeddedRunAttemptParams,
  type resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import { buildCodexPluginThreadConfigEligibilityLogData } from "./attempt-diagnostics.js";
import { withCodexStartupTimeout } from "./attempt-timeouts.js";
import type { CodexAppServerClientFactory } from "./client-factory.js";
import { isCodexAppServerConnectionClosedError, type CodexAppServerClient } from "./client.js";
import { ensureCodexComputerUse } from "./computer-use.js";
import {
  resolveCodexPluginsPolicy,
  withMcpElicitationsApprovalPolicy,
  type CodexAppServerRuntimeOptions,
  type CodexPluginConfig,
  type CodexComputerUseConfig,
} from "./config.js";
import {
  disableCodexPluginThreadConfig,
  resolveCodexAppServerExecutionCwd,
  resolveCodexExternalSandboxPolicyForOpenClawSandbox,
  resolveCodexSandboxEnvironmentSelection,
  shouldRequireCodexSandboxExecServerEnvironment,
} from "./dynamic-tool-build.js";
import { buildCodexPluginAppCacheKey } from "./plugin-app-cache-key.js";
import {
  buildCodexPluginThreadConfig,
  buildCodexPluginThreadConfigInputFingerprint,
  mergeCodexThreadConfigs,
  shouldBuildCodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import type {
  CodexDynamicToolSpec,
  CodexSandboxPolicy,
  CodexTurnEnvironmentParams,
  JsonObject,
} from "./protocol.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
  type CodexSandboxExecEnvironment,
} from "./sandbox-exec-server.js";
import {
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  clearSharedCodexAppServerClientIfCurrent,
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import {
  startOrResumeThread,
  type CodexAppServerThreadLifecycleBinding,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";

const CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS = 3;

type CodexSandboxContext = Awaited<ReturnType<typeof resolveSandboxContext>>;

/** Resources and bindings returned after a Codex attempt thread starts. */
export type StartCodexAttemptThreadResult = {
  client: CodexAppServerClient;
  thread: CodexAppServerThreadLifecycleBinding;
  pluginAppServer: CodexAppServerRuntimeOptions;
  sandboxEnvironment: CodexSandboxExecEnvironment | undefined;
  environmentSelection: CodexTurnEnvironmentParams[] | undefined;
  executionCwd: string;
  sandboxPolicy: CodexSandboxPolicy | undefined;
  releaseSharedClientLease: () => void;
  restartContextEngineCodexThread: () => Promise<CodexAppServerThreadLifecycleBinding>;
};

/**
 * Starts or resumes the Codex app-server thread and returns the resources the
 * run loop must later release.
 */
export async function startCodexAttemptThread(params: {
  attemptClientFactory: CodexAppServerClientFactory;
  appServer: CodexAppServerRuntimeOptions;
  pluginConfig: CodexPluginConfig;
  computerUseConfig: CodexComputerUseConfig;
  startupAuthProfileId: string | undefined;
  startupAuthAccountCacheKey: string | undefined;
  startupEnvApiKeyCacheKey: string | undefined;
  agentDir: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  buildAttemptParams: () => EmbeddedRunAttemptParams;
  sessionAgentId: string;
  effectiveWorkspace: string;
  effectiveCwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  developerInstructions: string | undefined;
  finalConfigPatch?: Parameters<typeof startOrResumeThread>[0]["finalConfigPatch"];
  buildFinalConfigPatch?: Parameters<typeof startOrResumeThread>[0]["buildFinalConfigPatch"];
  nativeHookRelayGeneration?: string;
  bundleMcpThreadConfig: CodexBundleMcpThreadConfig;
  nativeToolSurfaceEnabled: boolean;
  sandboxExecServerEnabled: boolean;
  sandbox: CodexSandboxContext;
  contextEngineProjection: CodexContextEngineThreadBootstrapProjection | undefined;
  startupTimeoutMs: number;
  signal: AbortSignal;
  onStartupTimeout: () => void | Promise<void>;
  spawnedBy: EmbeddedRunAttemptParams["spawnedBy"];
}): Promise<StartCodexAttemptThreadResult> {
  let pluginAppServer = params.appServer;
  let releaseSharedClientLease: (() => void) | undefined;
  let startupClientForAbandonedRequestCleanup: CodexAppServerClient | undefined;
  let releaseStartupResourcesOnTimeout: (() => Promise<void>) | undefined;
  let startupAbandoned = false;
  const startupAbandonController = new AbortController();
  const abandonStartupAcquire = () => startupAbandonController.abort();
  params.signal.addEventListener("abort", abandonStartupAcquire, { once: true });
  try {
    const startupResult = await withCodexStartupTimeout({
      timeoutMs: params.startupTimeoutMs,
      signal: params.signal,
      onTimeout: async () => {
        startupAbandoned = true;
        startupAbandonController.abort();
        await params.onStartupTimeout();
        await releaseStartupResourcesOnTimeout?.();
        releaseSharedClientLease?.();
        releaseSharedClientLease = undefined;
        await closeAbandonedStartupClient(startupClientForAbandonedRequestCleanup);
        startupClientForAbandonedRequestCleanup = undefined;
      },
      operation: async () => {
        const threadConfig = mergeCodexThreadConfigs(
          params.bundleMcpThreadConfig?.configPatch as JsonObject | undefined,
        );
        const nativeToolSurfaceRestricted = !params.nativeToolSurfaceEnabled;
        const pluginThreadConfigRequired =
          nativeToolSurfaceRestricted || shouldBuildCodexPluginThreadConfig(params.pluginConfig);
        // Restricted runs still need a plugin thread config so thread/start
        // carries the explicit apps._default denial patch without app/list.
        const pluginThreadConfigPluginConfig = params.nativeToolSurfaceEnabled
          ? params.pluginConfig
          : disableCodexPluginThreadConfig(params.pluginConfig);
        const pluginAppCacheKeyInput = {
          appServer: params.appServer,
          agentDir: params.agentDir,
          authProfileId: params.startupAuthProfileId,
          accountId: params.startupAuthAccountCacheKey,
          envApiKeyFingerprint: params.startupEnvApiKeyCacheKey,
        };
        const pluginAppCacheKey = buildCodexPluginAppCacheKey(pluginAppCacheKeyInput);
        const pluginThreadConfigInputFingerprint = pluginThreadConfigRequired
          ? buildCodexPluginThreadConfigInputFingerprint({
              pluginConfig: pluginThreadConfigPluginConfig,
              appCacheKey: pluginAppCacheKey,
            })
          : undefined;
        const resolvedPluginPolicy = pluginThreadConfigRequired
          ? resolveCodexPluginsPolicy(pluginThreadConfigPluginConfig)
          : undefined;
        const computerUseMcpElicitationDelegationRequired = params.computerUseConfig.enabled;
        const mcpElicitationDelegationRequired =
          resolvedPluginPolicy?.enabled === true || computerUseMcpElicitationDelegationRequired;
        const enabledPluginConfigKeys = resolvedPluginPolicy
          ? resolvedPluginPolicy.pluginPolicies
              .filter((plugin) => plugin.enabled)
              .map((plugin) => plugin.configKey)
              .toSorted()
          : undefined;
        const attemptParams = params.buildAttemptParams();
        embeddedAgentLog.debug(
          "codex plugin thread config eligibility",
          buildCodexPluginThreadConfigEligibilityLogData({
            sessionId: attemptParams.sessionId,
            sessionKey: attemptParams.sessionKey ?? "",
            pluginThreadConfigRequired,
            resolvedPluginPolicy,
            enabledPluginConfigKeys,
            pluginAppCacheKey,
            startupAuthProfileId: params.startupAuthProfileId,
            appServer: params.appServer,
          }),
        );
        pluginAppServer = mcpElicitationDelegationRequired
          ? {
              ...params.appServer,
              approvalPolicy: withMcpElicitationsApprovalPolicy(params.appServer.approvalPolicy),
            }
          : params.appServer;

        let attemptedClient: CodexAppServerClient | undefined;
        const startupAttempt = async () => {
          let startupClientLease: (() => void) | undefined;
          let startupClient: CodexAppServerClient | undefined;
          let startupAttemptError: unknown;
          let startupAttemptSucceeded = false;
          try {
            startupClient = await params.attemptClientFactory(
              params.appServer.start,
              params.startupAuthProfileId,
              params.agentDir,
              params.config,
              {
                onStartedClient: (client) => {
                  // Timeout cleanup may fire before the client factory resolves;
                  // close any late-arriving client instead of leaking a lease.
                  startupClientForAbandonedRequestCleanup = client;
                  if (startupAbandoned || startupAbandonController.signal.aborted) {
                    void closeAbandonedStartupClient(client);
                  }
                },
                abandonSignal: startupAbandonController.signal,
              },
            );
            const activeStartupClient = startupClient;
            let startupClientLeaseReleased = false;
            startupClientLease = () => {
              if (startupClientLeaseReleased) {
                return;
              }
              startupClientLeaseReleased = true;
              releaseLeasedSharedCodexAppServerClient(activeStartupClient);
            };
            releaseSharedClientLease = startupClientLease;
            attemptedClient = activeStartupClient;
            startupClientForAbandonedRequestCleanup = activeStartupClient;
            if (startupAbandoned) {
              throw new Error("codex app-server startup timed out");
            }
            if (startupAbandonController.signal.aborted) {
              throw new Error("codex app-server startup aborted");
            }
            await ensureCodexComputerUse({
              client: activeStartupClient,
              pluginConfig: params.pluginConfig,
              timeoutMs: params.appServer.requestTimeoutMs,
              signal: startupAbandonController.signal,
            });
            let startupSandboxEnvironment: CodexSandboxExecEnvironment | undefined;
            let startupSandboxEnvironmentAcquired = false;
            const releaseStartupSandboxEnvironment = async () => {
              if (startupSandboxEnvironmentAcquired) {
                startupSandboxEnvironmentAcquired = false;
                await releaseCodexSandboxExecServerEnvironment(params.sandbox);
              }
            };
            releaseStartupResourcesOnTimeout = releaseStartupSandboxEnvironment;
            try {
              startupSandboxEnvironment = shouldRequireCodexSandboxExecServerEnvironment({
                sandbox: params.sandbox,
                nativeToolSurfaceEnabled: params.nativeToolSurfaceEnabled,
                sandboxExecServerEnabled: params.sandboxExecServerEnabled,
              })
                ? await ensureCodexSandboxExecServerEnvironment({
                    client: activeStartupClient,
                    sandbox: params.sandbox ?? null,
                    appServerStartOptions: params.appServer.start,
                    timeoutMs: params.appServer.requestTimeoutMs,
                    signal: startupAbandonController.signal,
                  })
                : undefined;
              startupSandboxEnvironmentAcquired = Boolean(startupSandboxEnvironment);
              if (startupAbandonController.signal.aborted) {
                await releaseStartupSandboxEnvironment();
                throw new Error("codex app-server startup aborted");
              }
              if (
                params.sandbox?.enabled &&
                params.nativeToolSurfaceEnabled &&
                params.sandboxExecServerEnabled &&
                !startupSandboxEnvironment
              ) {
                throw new Error(
                  "Codex app-server did not register an OpenClaw sandbox exec-server environment.",
                );
              }
            } catch (error) {
              await releaseStartupSandboxEnvironment();
              throw error;
            }
            const startupEnvironmentSelection = resolveCodexSandboxEnvironmentSelection(
              startupSandboxEnvironment,
              params.nativeToolSurfaceEnabled,
            );
            const startupExecutionCwd = resolveCodexAppServerExecutionCwd({
              effectiveCwd: params.effectiveCwd,
              environment: startupSandboxEnvironment,
              nativeToolSurfaceEnabled: params.nativeToolSurfaceEnabled,
            });
            const startupSandboxPolicy = startupSandboxEnvironment
              ? resolveCodexExternalSandboxPolicyForOpenClawSandbox(params.sandbox)
              : undefined;
            const buildThreadLifecycleParams = (signal: AbortSignal) =>
              ({
                client: activeStartupClient,
                params: params.buildAttemptParams(),
                agentId: params.sessionAgentId,
                cwd: startupExecutionCwd,
                dynamicTools: params.dynamicTools,
                appServer: pluginAppServer,
                developerInstructions: params.developerInstructions,
                config: threadConfig,
                finalConfigPatch: params.finalConfigPatch,
                buildFinalConfigPatch: params.buildFinalConfigPatch,
                nativeHookRelayGeneration: params.nativeHookRelayGeneration,
                nativeCodeModeEnabled: params.nativeToolSurfaceEnabled,
                nativeCodeModeOnlyEnabled: params.appServer.codeModeOnly,
                userMcpServersEnabled: params.nativeToolSurfaceEnabled,
                mcpServersFingerprint: params.bundleMcpThreadConfig.fingerprint,
                mcpServersFingerprintEvaluated: params.bundleMcpThreadConfig.evaluated,
                environmentSelection: startupEnvironmentSelection,
                contextEngineProjection: params.contextEngineProjection,
                signal,
                pluginThreadConfig: pluginThreadConfigRequired
                  ? {
                      enabled: true,
                      inputFingerprint: pluginThreadConfigInputFingerprint,
                      enabledPluginConfigKeys,
                      build: () =>
                        buildCodexPluginThreadConfig({
                          pluginConfig: pluginThreadConfigPluginConfig,
                          request: (method, requestParams) =>
                            activeStartupClient.request(method, requestParams, {
                              timeoutMs: params.appServer.requestTimeoutMs,
                              signal,
                            }),
                          appCache: defaultCodexAppInventoryCache,
                          appCacheKey: pluginAppCacheKey,
                        }),
                    }
                  : undefined,
              }) satisfies Parameters<typeof startOrResumeThread>[0];
            try {
              const startupThread = await startOrResumeThread(
                buildThreadLifecycleParams(startupAbandonController.signal),
              );
              if (startupAbandonController.signal.aborted) {
                await releaseStartupSandboxEnvironment();
                throw new Error("codex app-server startup aborted");
              }
              startupSandboxEnvironmentAcquired = false;
              startupAttemptSucceeded = true;
              return {
                client: activeStartupClient,
                thread: startupThread,
                sandboxEnvironment: startupSandboxEnvironment,
                environmentSelection: startupEnvironmentSelection,
                executionCwd: startupExecutionCwd,
                sandboxPolicy: startupSandboxPolicy,
                restartContextEngineCodexThread: () =>
                  startOrResumeThread(buildThreadLifecycleParams(params.signal)),
              };
            } catch (error) {
              await releaseStartupSandboxEnvironment();
              throw error;
            } finally {
              if (releaseStartupResourcesOnTimeout === releaseStartupSandboxEnvironment) {
                releaseStartupResourcesOnTimeout = undefined;
              }
            }
          } catch (error) {
            startupAttemptError = error;
            throw error;
          } finally {
            if (!startupAttemptSucceeded) {
              if (releaseSharedClientLease === startupClientLease) {
                releaseSharedClientLease = undefined;
              }
              startupClientLease?.();
              if (startupAbandoned || params.signal.aborted) {
                if (startupClientForAbandonedRequestCleanup === startupClient) {
                  startupClientForAbandonedRequestCleanup = undefined;
                }
                await closeAbandonedStartupClient(startupClient);
              } else if (
                shouldClearSharedClientAfterStartupRace(startupAttemptError) ||
                shouldClearSharedClientAfterStartupFailure({
                  error: startupAttemptError,
                  spawnedBy: params.spawnedBy,
                })
              ) {
                if (startupClientForAbandonedRequestCleanup === startupClient) {
                  startupClientForAbandonedRequestCleanup = undefined;
                }
                await evictFailedStartupClient(startupClient);
              }
            }
          }
        };

        for (
          let attempt = 1;
          attempt <= CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS;
          attempt += 1
        ) {
          try {
            return await startupAttempt();
          } catch (error) {
            if (params.signal.aborted || !isCodexAppServerConnectionClosedError(error)) {
              throw error;
            }
            const failedClient = attemptedClient;
            const clearedSharedClient = clearSharedCodexAppServerClientIfCurrent(failedClient);
            if (startupClientForAbandonedRequestCleanup === failedClient) {
              startupClientForAbandonedRequestCleanup = undefined;
            }
            if (attempt >= CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS) {
              embeddedAgentLog.warn(
                "codex app-server connection closed during startup; retries exhausted",
                {
                  attempt,
                  maxAttempts: CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS,
                  clearedSharedClient,
                  error: formatErrorMessage(error),
                },
              );
              throw error;
            }
            embeddedAgentLog.warn(
              "codex app-server connection closed during startup; restarting app-server and retrying",
              {
                attempt,
                nextAttempt: attempt + 1,
                maxAttempts: CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS,
                clearedSharedClient,
                error: formatErrorMessage(error),
              },
            );
          }
        }
        throw new Error("codex app-server startup retry loop exited unexpectedly");
      },
    });
    startupClientForAbandonedRequestCleanup = undefined;
    if (!releaseSharedClientLease) {
      throw new Error("codex app-server startup succeeded without a shared client lease");
    }
    return {
      ...startupResult,
      pluginAppServer,
      releaseSharedClientLease,
    };
  } catch (error) {
    if (params.signal.aborted || shouldClearSharedClientAfterStartupAbandon(error)) {
      releaseSharedClientLease?.();
      releaseSharedClientLease = undefined;
      await closeAbandonedStartupClient(startupClientForAbandonedRequestCleanup);
      startupClientForAbandonedRequestCleanup = undefined;
    } else if (
      shouldClearSharedClientAfterStartupRace(error) ||
      shouldClearSharedClientAfterStartupFailure({
        error,
        spawnedBy: params.spawnedBy,
      })
    ) {
      releaseSharedClientLease?.();
      releaseSharedClientLease = undefined;
      await evictFailedStartupClient(startupClientForAbandonedRequestCleanup);
      startupClientForAbandonedRequestCleanup = undefined;
    }
    throw error;
  } finally {
    params.signal.removeEventListener("abort", abandonStartupAcquire);
  }
}

async function closeAbandonedStartupClient(
  client: CodexAppServerClient | undefined,
): Promise<void> {
  if (!client) {
    return;
  }
  const unclaimedSharedClient = clearSharedCodexAppServerClientIfCurrentAndUnclaimed(client);
  if (unclaimedSharedClient.closed) {
    await closeClientAndWaitIfAvailable(client);
    return;
  }
  if (unclaimedSharedClient.found) {
    const retired = retireSharedCodexAppServerClientIfCurrent(client);
    if (retired?.closed) {
      await closeClientAndWaitIfAvailable(client);
    }
    return;
  }
  const retiredSharedClient = retireSharedCodexAppServerClientIfCurrent(client);
  if (retiredSharedClient) {
    if (retiredSharedClient.closed) {
      await closeClientAndWaitIfAvailable(client);
    }
    return;
  }
  if (clearSharedCodexAppServerClientIfCurrent(client)) {
    await closeClientAndWaitIfAvailable(client);
    return;
  }
  await closeClientAndWaitIfAvailable(client);
}

async function closeClientAndWaitIfAvailable(client: CodexAppServerClient): Promise<void> {
  const closeable = client as {
    close?: CodexAppServerClient["close"];
    closeAndWait?: CodexAppServerClient["closeAndWait"];
  };
  if (typeof closeable.closeAndWait === "function") {
    await closeable.closeAndWait();
    return;
  }
  closeable.close?.();
}

async function evictFailedStartupClient(client: CodexAppServerClient | undefined): Promise<void> {
  if (!client) {
    return;
  }
  const unclaimedSharedClient = clearSharedCodexAppServerClientIfCurrentAndUnclaimed(client);
  if (unclaimedSharedClient.closed) {
    await closeClientAndWaitIfAvailable(client);
    return;
  }
  if (unclaimedSharedClient.found) {
    const retired = retireSharedCodexAppServerClientIfCurrent(client);
    if (retired?.closed) {
      await closeClientAndWaitIfAvailable(client);
    }
    return;
  }
  const retiredSharedClient = retireSharedCodexAppServerClientIfCurrent(client);
  if (retiredSharedClient) {
    if (retiredSharedClient.closed) {
      await closeClientAndWaitIfAvailable(client);
    }
    return;
  }
  if (clearSharedCodexAppServerClientIfCurrent(client)) {
    await closeClientAndWaitIfAvailable(client);
    return;
  }
  await closeClientAndWaitIfAvailable(client);
}

function shouldClearSharedClientAfterStartupAbandon(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "codex app-server startup timed out" ||
      error.message === "codex app-server startup aborted")
  );
}

function shouldClearSharedClientAfterStartupRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    (shouldClearSharedClientAfterStartupAbandon(error) || error.message.endsWith(" timed out"))
  );
}

function shouldClearSharedClientAfterStartupFailure(params: {
  error: unknown;
  spawnedBy: EmbeddedRunAttemptParams["spawnedBy"];
}): boolean {
  if (!(params.error instanceof Error)) {
    return !params.spawnedBy;
  }
  if (params.error.message.includes("write EPIPE")) {
    return true;
  }
  return !params.spawnedBy;
}

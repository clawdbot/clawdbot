/**
 * Startup orchestration for Codex app-server attempts, including shared-client
 * leasing, plugin thread config, sandbox environment, and thread lifecycle binding.
 */
import {
  embeddedAgentLog,
  formatErrorMessage,
  type AgentHarnessRuntimeArtifactBinding,
  type CodexBundleMcpThreadConfig,
  type EmbeddedRunAttemptParams,
  type resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  CodexAppServerUnsafeSubscriptionError,
  closeCodexStartupClientBestEffort,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { buildCodexPluginThreadConfigEligibilityLogData } from "./attempt-diagnostics.js";
import { withCodexStartupTimeout } from "./attempt-timeouts.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { isCodexAppServerConnectionClosedError, type CodexAppServerClient } from "./client.js";
import { startCodexComputerUseHealthMonitor } from "./computer-use-health.js";
import { ensureCodexComputerUse } from "./computer-use.js";
import {
  withMcpElicitationsApprovalPolicy,
  type CodexAppServerRuntimeOptions,
  type CodexPluginConfig,
  type ResolvedCodexComputerUseConfig,
} from "./config.js";
import {
  resolveCodexAppServerExecutionCwd,
  resolveCodexExternalSandboxPolicyForOpenClawSandbox,
  resolveCodexSandboxEnvironmentSelection,
  shouldRequireCodexSandboxExecServerEnvironment,
} from "./dynamic-tool-build.js";
import {
  buildCodexAppServerRuntimeFingerprint,
  buildCodexPluginAppCacheKey,
} from "./plugin-app-cache-key.js";
import {
  createCodexPluginThreadConfigStartupProvider,
  resolveCodexPluginThreadConfigStartupPolicy,
} from "./plugin-thread-config-deadline.js";
import {
  buildCodexPluginThreadConfigInputFingerprint,
  mergeCodexThreadConfigs,
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
import type { CodexAppServerBindingStore } from "./session-binding.js";
import {
  clearSharedCodexAppServerClientIfCurrent,
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  isCodexAppServerStartSelectionChangedError,
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
  type CodexAppServerClientOptions,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import {
  startOrResumeThread,
  type CodexAppServerThreadLifecycleBinding,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";
import {
  getCodexAppServerTurnRouter,
  type CodexAppServerTurnRouter,
  type CodexThreadRouteReservation,
} from "./turn-router.js";
import type { CodexNativeWebSearchSupport } from "./web-search.js";

const CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS = 3;
const CODEX_APP_SERVER_CONTEXT_RESTART_SELECTION_CHANGED =
  "CODEX_APP_SERVER_CONTEXT_RESTART_SELECTION_CHANGED";

/** True when a pre-write context restart must replay on the newly selected owner. */
export function isCodexContextRestartSelectionChangedError(
  error: unknown,
): error is Error & { code: typeof CODEX_APP_SERVER_CONTEXT_RESTART_SELECTION_CHANGED } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === CODEX_APP_SERVER_CONTEXT_RESTART_SELECTION_CHANGED
  );
}

type CodexSandboxContext = Awaited<ReturnType<typeof resolveSandboxContext>>;

/** Resources and bindings returned after a Codex attempt thread starts. */
type StartCodexAttemptThreadResult = {
  client: CodexAppServerClient;
  turnRouter: CodexAppServerTurnRouter;
  turnRoute: CodexThreadRouteReservation;
  thread: CodexAppServerThreadLifecycleBinding;
  pluginAppServer: CodexAppServerRuntimeOptions;
  sandboxEnvironment: CodexSandboxExecEnvironment | undefined;
  environmentSelection: CodexTurnEnvironmentParams[] | undefined;
  executionCwd: string;
  sandboxPolicy: CodexSandboxPolicy | undefined;
  runtimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  releaseSharedClientLease: () => void;
  restartContextEngineCodexThread: () => Promise<CodexAppServerThreadLifecycleBinding>;
};

/**
 * Starts or resumes the Codex app-server thread and returns the resources the
 * run loop must later release.
 */
export async function startCodexAttemptThread(params: {
  attemptClientFactory: CodexAppServerClientFactory;
  bindingStore: CodexAppServerBindingStore;
  appServer: CodexAppServerRuntimeOptions;
  pluginConfig: CodexPluginConfig;
  computerUseConfig: ResolvedCodexComputerUseConfig;
  startupAuthProfileId: string | null | undefined;
  startupAuthRequirement?: CodexAppServerClientOptions["authRequirement"];
  startupAuthBindingFingerprint: string | undefined;
  runtimeArtifactRequest?: Readonly<{
    expected?: AgentHarnessRuntimeArtifactBinding;
  }>;
  startupPreparedAuth?: CodexAppServerClientOptions["preparedAuth"];
  startupAuthAccountCacheKey: string | undefined;
  startupEnvApiKeyCacheKey: string | undefined;
  agentDir: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  buildAttemptParams: () => EmbeddedRunAttemptParams;
  sessionAgentId: string;
  effectiveWorkspace: string;
  effectiveCwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  persistentWebSearchAllowed?: boolean;
  webSearchAllowed: boolean;
  developerInstructions: string | undefined;
  finalConfigPatch?: Parameters<typeof startOrResumeThread>[0]["finalConfigPatch"];
  buildFinalConfigPatch?: Parameters<typeof startOrResumeThread>[0]["buildFinalConfigPatch"];
  nativeHookRelayGeneration?: string;
  bundleMcpThreadConfig: CodexBundleMcpThreadConfig;
  nativeToolSurfaceEnabled: boolean;
  nativeProviderWebSearchSupport: CodexNativeWebSearchSupport;
  sandboxExecServerEnabled: boolean;
  sandbox: CodexSandboxContext;
  contextEngineProjection: CodexContextEngineThreadBootstrapProjection | undefined;
  startupTimeoutMs: number;
  signal: AbortSignal;
  onStartupTimeout: () => void | Promise<void>;
  spawnedBy: EmbeddedRunAttemptParams["spawnedBy"];
}): Promise<StartCodexAttemptThreadResult> {
  let pluginAppServer = params.appServer;
  const startupRuntimeAuthProfileId =
    params.startupPreparedAuth?.kind === "profile"
      ? params.startupPreparedAuth.profileId
      : (params.startupAuthProfileId ?? undefined);
  const startupRuntimeAuthProfileStore =
    params.startupPreparedAuth?.kind === "profile" ? params.startupPreparedAuth.store : undefined;
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
        await closeCodexStartupClientBestEffort(startupClientForAbandonedRequestCleanup);
        startupClientForAbandonedRequestCleanup = undefined;
      },
      operation: async () => {
        const threadConfig = mergeCodexThreadConfigs(
          params.bundleMcpThreadConfig?.configPatch as JsonObject | undefined,
        );
        const pluginStartupPolicy = resolveCodexPluginThreadConfigStartupPolicy({
          pluginConfig: params.pluginConfig,
          nativeToolSurfaceEnabled: params.nativeToolSurfaceEnabled,
        });
        const {
          pluginThreadConfigRequired,
          pluginThreadConfigPluginConfig,
          resolvedPluginPolicy,
          enabledPluginConfigKeys,
        } = pluginStartupPolicy;
        const computerUseMcpElicitationDelegationRequired = params.computerUseConfig.enabled;
        const mcpElicitationDelegationRequired =
          resolvedPluginPolicy?.enabled === true || computerUseMcpElicitationDelegationRequired;
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
            const attemptParams = params.buildAttemptParams();
            startupClient = await params.attemptClientFactory({
              startOptions: params.appServer.start,
              ...(params.startupPreparedAuth
                ? { preparedAuth: params.startupPreparedAuth }
                : { authProfileId: params.startupAuthProfileId }),
              authRequirement: params.startupAuthRequirement,
              authProfileStore: attemptParams.authProfileStore,
              authBindingFingerprint: params.startupAuthBindingFingerprint,
              ...(params.runtimeArtifactRequest
                ? {
                    runtimeArtifactMode: "capture" as const,
                    ...(params.runtimeArtifactRequest.expected
                      ? { expectedRuntimeArtifact: params.runtimeArtifactRequest.expected }
                      : {}),
                  }
                : {}),
              agentDir: params.agentDir,
              config: params.config,
              onStartedClient: (client) => {
                // Timeout cleanup may fire before the client factory resolves;
                // close any late-arriving client instead of leaking a lease.
                startupClientForAbandonedRequestCleanup = client;
                if (startupAbandoned || startupAbandonController.signal.aborted) {
                  void closeCodexStartupClientBestEffort(client);
                }
              },
              abandonSignal: startupAbandonController.signal,
              timeoutMs: params.appServer.requestTimeoutMs,
            });
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
            let runtimeArtifact: AgentHarnessRuntimeArtifactBinding | undefined;
            if (params.runtimeArtifactRequest) {
              const {
                readCodexAppServerClientRuntimeArtifact,
                validateCodexAppServerRuntimeArtifact,
              } = await import("./runtime-artifact.js");
              runtimeArtifact = readCodexAppServerClientRuntimeArtifact(activeStartupClient);
              const expected = params.runtimeArtifactRequest.expected;
              const matchesExpected =
                !expected ||
                Boolean(
                  runtimeArtifact &&
                  runtimeArtifact.id === expected.id &&
                  runtimeArtifact.fingerprint === expected.fingerprint,
                );
              if (
                !runtimeArtifact ||
                !matchesExpected ||
                !(await validateCodexAppServerRuntimeArtifact(
                  runtimeArtifact,
                  startupAbandonController.signal,
                ))
              ) {
                // Never let an unattested physical generation reach Computer Use,
                // plugin discovery, or a native thread request.
                retireSharedCodexAppServerClientIfCurrent(activeStartupClient);
                throw new Error(
                  expected
                    ? "Codex app-server runtime artifact does not match verified inference"
                    : "Codex app-server runtime artifact is unavailable or stale",
                );
              }
            }
            ensureCodexAppServerClientRuntime(activeStartupClient, {
              agentDir: params.agentDir,
              authProfileId: startupRuntimeAuthProfileId,
              authMode:
                params.startupPreparedAuth?.kind === "api-key" ? "prepared-api-key" : "profile",
              authProfileStore: startupRuntimeAuthProfileStore ?? attemptParams.authProfileStore,
              config: params.config,
            });
            const turnRouter = getCodexAppServerTurnRouter(activeStartupClient);
            await ensureCodexComputerUse({
              client: activeStartupClient,
              pluginConfig: params.pluginConfig,
              config: params.config,
              agentDir: params.agentDir,
              timeoutMs: params.appServer.requestTimeoutMs,
              signal: startupAbandonController.signal,
            });
            const startupRuntimeIdentity = activeStartupClient.getRuntimeIdentity();
            const pluginAppCacheKey = buildCodexPluginAppCacheKey({
              appServer: params.appServer,
              agentDir: params.agentDir,
              authProfileId: startupRuntimeAuthProfileId,
              accountId: params.startupAuthAccountCacheKey,
              envApiKeyFingerprint: params.startupEnvApiKeyCacheKey,
              appServerVersion: activeStartupClient.getServerVersion(),
              runtimeIdentity: startupRuntimeIdentity,
            });
            const appServerRuntimeFingerprint = buildCodexAppServerRuntimeFingerprint({
              appServer: params.appServer,
              appServerVersion: activeStartupClient.getServerVersion(),
              runtimeIdentity: startupRuntimeIdentity,
            });
            const pluginThreadConfigInputFingerprint = pluginThreadConfigRequired
              ? buildCodexPluginThreadConfigInputFingerprint({
                  pluginConfig: pluginThreadConfigPluginConfig,
                  appCacheKey: pluginAppCacheKey,
                })
              : undefined;
            embeddedAgentLog.debug(
              "codex plugin thread config eligibility",
              buildCodexPluginThreadConfigEligibilityLogData({
                sessionId: attemptParams.sessionId,
                sessionKey: attemptParams.sessionKey ?? "",
                pluginThreadConfigRequired,
                resolvedPluginPolicy,
                enabledPluginConfigKeys,
                pluginAppCacheKey,
                startupAuthProfileId: startupRuntimeAuthProfileId,
                appServer: params.appServer,
              }),
            );
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
              localWorkspaceRoot: params.effectiveWorkspace,
              environment: startupSandboxEnvironment,
              nativeToolSurfaceEnabled: params.nativeToolSurfaceEnabled,
              remoteWorkspaceRoot: params.appServer.remoteWorkspaceRoot,
            });
            const startupSandboxPolicy = startupSandboxEnvironment
              ? resolveCodexExternalSandboxPolicyForOpenClawSandbox(params.sandbox)
              : undefined;
            let startupReservation: CodexThreadRouteReservation | undefined;
            const releaseStartupReservation = () => {
              startupReservation?.release();
              startupReservation = undefined;
            };
            const reserveStartupThread = (threadId: string) => {
              if (startupReservation) {
                if (startupReservation.threadId !== threadId) {
                  throw new Error(
                    `codex app-server reserved ${startupReservation.threadId} but started ${threadId}`,
                  );
                }
                return { release: releaseStartupReservation };
              }
              startupReservation = turnRouter.reserveThread({
                threadId,
                releaseOn: params.signal,
              });
              return { release: releaseStartupReservation };
            };
            const releaseStartupResources = async () => {
              releaseStartupReservation();
              await releaseStartupSandboxEnvironment();
            };
            releaseStartupResourcesOnTimeout = releaseStartupResources;
            const buildThreadLifecycleParams = (
              signal: AbortSignal,
              reserveResumeThread?: typeof reserveStartupThread,
            ) =>
              ({
                client: activeStartupClient,
                reserveResumeThread,
                bindingStore: params.bindingStore,
                params: params.buildAttemptParams(),
                agentId: params.sessionAgentId,
                cwd: startupExecutionCwd,
                dynamicTools: params.dynamicTools,
                persistentWebSearchAllowed: params.persistentWebSearchAllowed,
                webSearchAllowed: params.webSearchAllowed,
                appServer: pluginAppServer,
                developerInstructions: params.developerInstructions,
                config: threadConfig,
                finalConfigPatch: params.finalConfigPatch,
                buildFinalConfigPatch: params.buildFinalConfigPatch,
                nativeHookRelayGeneration: params.nativeHookRelayGeneration,
                nativeCodeModeEnabled: params.nativeToolSurfaceEnabled,
                nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
                nativeCodeModeOnlyEnabled: params.appServer.codeModeOnly,
                userMcpServersEnabled: params.nativeToolSurfaceEnabled,
                mcpServersFingerprint: params.bundleMcpThreadConfig.fingerprint,
                mcpServersFingerprintEvaluated: params.bundleMcpThreadConfig.evaluated,
                environmentSelection: startupEnvironmentSelection,
                appServerRuntimeFingerprint,
                contextEngineProjection: params.contextEngineProjection,
                signal,
                pluginThreadConfig: pluginThreadConfigRequired
                  ? createCodexPluginThreadConfigStartupProvider({
                      inputFingerprint: pluginThreadConfigInputFingerprint,
                      enabledPluginConfigKeys,
                      policy: resolvedPluginPolicy,
                      requestTimeoutMs: params.appServer.requestTimeoutMs,
                      signal,
                      pluginConfig: pluginThreadConfigPluginConfig,
                      client: activeStartupClient,
                      configCwd: startupExecutionCwd,
                      appCacheKey: pluginAppCacheKey,
                    })
                  : undefined,
              }) satisfies Parameters<typeof startOrResumeThread>[0];
            try {
              const startupThread = await startOrResumeThread(
                buildThreadLifecycleParams(startupAbandonController.signal, reserveStartupThread),
              );
              try {
                // Fresh starts reach here unreserved; resumes reserved before
                // thread/resume so their early notifications are already buffered.
                reserveStartupThread(startupThread.threadId);
              } catch (error) {
                const unsubscribed = await unsubscribeCodexThreadBestEffort(activeStartupClient, {
                  threadId: startupThread.threadId,
                  timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
                });
                if (!unsubscribed) {
                  throw new CodexAppServerUnsafeSubscriptionError(
                    "Codex startup subscription cleanup failed",
                    { cause: error },
                  );
                }
                throw error;
              }
              if (startupAbandonController.signal.aborted) {
                throw new Error("codex app-server startup aborted");
              }
              const startupRoute = startupReservation;
              if (!startupRoute) {
                throw new Error("codex app-server startup did not reserve its thread route");
              }
              startupSandboxEnvironmentAcquired = false;
              startCodexComputerUseHealthMonitor({
                client: activeStartupClient,
                config: params.computerUseConfig,
              });
              startupAttemptSucceeded = true;
              return {
                client: activeStartupClient,
                turnRouter,
                turnRoute: startupRoute,
                thread: startupThread,
                sandboxEnvironment: startupSandboxEnvironment,
                environmentSelection: startupEnvironmentSelection,
                executionCwd: startupExecutionCwd,
                sandboxPolicy: startupSandboxPolicy,
                ...(runtimeArtifact ? { runtimeArtifact } : {}),
                restartContextEngineCodexThread: async () => {
                  try {
                    return await startOrResumeThread(buildThreadLifecycleParams(params.signal));
                  } catch (error) {
                    if (!isCodexAppServerStartSelectionChangedError(error)) {
                      throw error;
                    }
                    // The run loop cannot safely swap the physical client, router,
                    // and lease halfway through an overflow retry. Retire this
                    // generation so the next bounded attempt acquires the owner
                    // selected by the now-current native config.
                    retireSharedCodexAppServerClientIfCurrent(activeStartupClient);
                    throw Object.assign(
                      new Error("codex app-server client is closed", { cause: error }),
                      { code: CODEX_APP_SERVER_CONTEXT_RESTART_SELECTION_CHANGED },
                    );
                  }
                },
              };
            } catch (error) {
              await releaseStartupResources();
              throw error;
            } finally {
              if (releaseStartupResourcesOnTimeout === releaseStartupResources) {
                releaseStartupResourcesOnTimeout = undefined;
              }
            }
          } catch (error) {
            startupAttemptError = error;
            if (!startupAbandoned && !params.signal.aborted && !startupClient) {
              const sharedClient = clearSharedCodexAppServerClientIfCurrentAndUnclaimed(
                startupClientForAbandonedRequestCleanup,
              );
              if (sharedClient.found && !sharedClient.closed) {
                // Shared acquisition already released this caller. A peer still
                // owns the client, so outer cleanup must not retire it.
                startupClientForAbandonedRequestCleanup = undefined;
              }
            }
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
                await closeCodexStartupClientBestEffort(startupClient);
              } else if (
                !isCodexAppServerStartSelectionChangedError(startupAttemptError) &&
                (shouldClearSharedClientAfterStartupRace(startupAttemptError) ||
                  shouldClearSharedClientAfterStartupFailure({
                    error: startupAttemptError,
                    spawnedBy: params.spawnedBy,
                  }))
              ) {
                if (startupClientForAbandonedRequestCleanup === startupClient) {
                  startupClientForAbandonedRequestCleanup = undefined;
                }
                await closeCodexStartupClientBestEffort(startupClient);
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
            const selectionChanged = isCodexAppServerStartSelectionChangedError(error);
            if (
              startupAbandoned ||
              params.signal.aborted ||
              (!selectionChanged && !isCodexAppServerConnectionClosedError(error))
            ) {
              throw error;
            }
            const failedClient = attemptedClient;
            const refreshedSharedClient = selectionChanged
              ? retireSharedCodexAppServerClientIfCurrent(failedClient)
              : clearSharedCodexAppServerClientIfCurrent(failedClient);
            if (startupClientForAbandonedRequestCleanup === failedClient) {
              startupClientForAbandonedRequestCleanup = undefined;
            }
            if (attempt >= CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS) {
              embeddedAgentLog.warn(
                selectionChanged
                  ? "codex app-server executable selection kept changing during startup; retries exhausted"
                  : "codex app-server connection closed during startup; retries exhausted",
                {
                  attempt,
                  maxAttempts: CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS,
                  refreshedSharedClient,
                  error: formatErrorMessage(error),
                },
              );
              throw error;
            }
            embeddedAgentLog.warn(
              selectionChanged
                ? "codex app-server executable selection changed during startup; restarting app-server and retrying"
                : "codex app-server connection closed during startup; restarting app-server and retrying",
              {
                attempt,
                nextAttempt: attempt + 1,
                maxAttempts: CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS,
                refreshedSharedClient,
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
      await closeCodexStartupClientBestEffort(startupClientForAbandonedRequestCleanup);
      startupClientForAbandonedRequestCleanup = undefined;
    } else if (
      !isCodexAppServerStartSelectionChangedError(error) &&
      (shouldClearSharedClientAfterStartupRace(error) ||
        shouldClearSharedClientAfterStartupFailure({
          error,
          spawnedBy: params.spawnedBy,
        }))
    ) {
      releaseSharedClientLease?.();
      releaseSharedClientLease = undefined;
      await closeCodexStartupClientBestEffort(startupClientForAbandonedRequestCleanup);
      startupClientForAbandonedRequestCleanup = undefined;
    }
    throw error;
  } finally {
    params.signal.removeEventListener("abort", abandonStartupAcquire);
  }
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

import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  isCodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  consumeCodexAppServerLiveThread,
  isCodexAppServerClientRuntimeLive,
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { applyCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import { attestCodexPluginThreadApps } from "./plugin-thread-attestation.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  mergeCodexThreadConfigs,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import {
  captureExclusiveSharedCodexAppServerClient,
  retainSharedCodexAppServerClientByInstanceId,
} from "./shared-client.js";
import { fingerprintCodexThreadConfig } from "./thread-fingerprints.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";
import type { CodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
  CodexThreadRequestContext,
  CodexThreadFinalConfigPatchResult,
} from "./thread-lifecycle-types.js";
import { buildThreadResumeParams } from "./thread-requests.js";

type CodexWarmThreadReuseParams = CodexThreadRequestContext & {
  params: CodexStartOrResumeThreadParams;
  binding: CodexAppServerThreadBinding;
  clientId?: string;
  buildLoadedPluginThreadConfig: (
    binding: CodexAppServerThreadBinding,
  ) => Promise<CodexPluginThreadConfig | undefined>;
};

type CodexWarmThreadReuseResult =
  | { kind: "ready"; binding: CodexAppServerThreadLifecycleBinding }
  | { kind: "rotate" }
  | { kind: "resume"; prebuiltFinalConfigPatch?: CodexThreadFinalConfigPatchResult };

type CodexLiveThreadReleaseParams = {
  client: CodexAppServerClient;
  abandonClient?: () => Promise<void>;
  lifecycleTiming: CodexThreadLifecycleTimingTracker;
  threadId: string;
  cause?: unknown;
  assertCurrent?: () => void;
};

/** Preserves the caller's abort reason across thread ownership transitions. */
export function throwIfCodexThreadLifecycleAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  const error = new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "codex app-server thread lifecycle aborted",
  );
  error.name = "AbortError";
  throw error;
}

/** Releases consumed subscription ownership or retires an unsafe client. */
export async function releaseCodexConsumedLiveThread(
  options: CodexLiveThreadReleaseParams,
): Promise<void> {
  const released = await options.lifecycleTiming.measure("retained-thread-unsubscribe", () =>
    unsubscribeCodexThreadBestEffort(options.client, {
      threadId: options.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      assertCurrent: options.assertCurrent,
    }),
  );
  if (released) {
    return;
  }
  return await abandonCodexLiveThreadRelease(options, options.cause);
}

async function abandonCodexLiveThreadRelease(
  options: CodexLiveThreadReleaseParams,
  cause?: unknown,
): Promise<never> {
  options.assertCurrent?.();
  await (options.abandonClient ?? (() => closeCodexStartupClientBestEffort(options.client)))();
  throw new CodexAppServerUnsafeSubscriptionError(
    `Codex retained thread subscription could not be released: ${options.threadId}`,
    cause !== undefined ? { cause } : undefined,
  );
}

/** Releases through the retained owner, preserving its guarded callback and rollback. */
async function releaseCodexRetainedLiveThread(
  options: CodexLiveThreadReleaseParams,
): Promise<boolean> {
  try {
    return await options.lifecycleTiming.measure("retained-thread-unsubscribe", () =>
      releaseCodexAppServerLiveThread(options.client, options.threadId, options.assertCurrent),
    );
  } catch (error) {
    // An owner callback may already have retired the client; do not close it twice.
    if (isCodexAppServerUnsafeSubscriptionError(error)) {
      throw error;
    }
    return await abandonCodexLiveThreadRelease(options, error);
  }
}

/** Release follows the physical owner across connection rotation, never a copied thread id. */
export async function releaseCodexBoundLiveThread(
  options: CodexLiveThreadReleaseParams & { clientId?: string; ownerClientId?: string },
): Promise<boolean> {
  const changedClient = options.ownerClientId && options.ownerClientId !== options.clientId;
  const previous = changedClient
    ? retainSharedCodexAppServerClientByInstanceId(options.ownerClientId!)
    : undefined;
  if (changedClient && !previous) {
    return false;
  }
  try {
    const client = previous?.client ?? options.client;
    const assertPrevious =
      previous && options.assertCurrent
        ? captureExclusiveSharedCodexAppServerClient(client)
        : undefined;
    if (isCodexAppServerLiveThreadClaimed(client, options.threadId)) {
      throw new Error(`Codex thread ${options.threadId} is claimed by active work; stop it first.`);
    }
    return await releaseCodexRetainedLiveThread({
      ...options,
      client,
      abandonClient: previous ? undefined : options.abandonClient,
      assertCurrent: options.assertCurrent
        ? () => {
            options.assertCurrent?.();
            assertPrevious?.();
          }
        : undefined,
    });
  } finally {
    previous?.release();
  }
}

/** Reuses one safely owned, fully matching subscription on its original client. */
export async function tryReuseCodexLiveThread(
  options: CodexWarmThreadReuseParams,
): Promise<CodexWarmThreadReuseResult> {
  const {
    params,
    binding,
    bindingIdentity,
    clientId,
    dynamicToolsFingerprint,
    environmentSelectionFingerprint,
    hostSystemAgentActive,
    lifecycleTiming,
    nativeSkillIsolation,
    ringZeroActive,
    restrictedToolSurfaceInheritedMcpServerNames,
    startModelProvider,
    startModelSelection,
    throwIfAborted,
    userMcpServersConfigPatch,
  } = options;

  if (
    !binding.clientId ||
    binding.clientId !== clientId ||
    binding.preserveNativeModel === true ||
    binding.connectionScope === "supervision" ||
    ringZeroActive
  ) {
    return { kind: "resume" };
  }

  const retainedThread = await consumeCodexAppServerLiveThread(params.client, binding.threadId);
  if (!retainedThread) {
    return { kind: "resume" };
  }
  const assertCurrentClient = () => {
    throwIfAborted();
    // Startup attaches router abort after this lifecycle call. A closed client's
    // inventory failure must not be treated as revocation of the durable binding.
    if (!isCodexAppServerClientRuntimeLive(params.client)) {
      throw params.client.getCloseError() ?? new Error("codex app-server client is closed");
    }
  };
  let ownershipTransferred = false;
  try {
    const pluginThreadConfig = await options.buildLoadedPluginThreadConfig(binding);
    assertCurrentClient();
    if (pluginThreadConfig && pluginThreadConfig.fingerprint !== binding.pluginAppsFingerprint) {
      return { kind: "rotate" };
    }
    // Engine identity, projection epoch, and policy were checked by the owner
    // before this call; compatible bootstrap threads must keep their session.

    const prebuiltFinalConfigPatch = params.buildFinalConfigPatch?.({
      action: "resume",
      binding,
    }) ?? {
      configPatch: params.finalConfigPatch,
      nativeHookRelayGeneration: params.nativeHookRelayGeneration,
    };
    const pluginAppsConfigPatch =
      pluginThreadConfig?.configPatch ??
      (params.pluginThreadConfig?.enabled && binding.pluginAppPolicyContext
        ? buildCodexPluginAppsConfigPatchFromPolicyContext(binding.pluginAppPolicyContext)
        : undefined);
    const resumeAuthProfileId = params.params.authProfileId ?? binding.authProfileId;
    const resumeConfig = mergeCodexThreadConfigs(
      params.config,
      userMcpServersConfigPatch,
      pluginAppsConfigPatch,
      prebuiltFinalConfigPatch.configPatch,
    );
    const resumeParams = lifecycleTiming.measureSync("warm-thread-resume-params", () =>
      buildThreadResumeParams(params.params, {
        threadId: binding.threadId,
        cwd: params.cwd,
        authProfileId: resumeAuthProfileId,
        model: startModelSelection.model,
        modelProvider: startModelProvider,
        preserveNativeModel: false,
        appServer: params.appServer,
        dynamicTools: params.dynamicTools,
        developerInstructions: params.developerInstructions,
        config: applyCodexNativeSkillIsolation(resumeConfig, nativeSkillIsolation),
        nativeCodeModeEnabled: params.nativeCodeModeEnabled,
        nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
        nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
        webSearchAllowed: params.webSearchAllowed,
        hostSystemAgentActive,
        restrictedToolSurfaceInheritedMcpServerNames,
        shellEnvironment: params.shellEnvironment,
        disableLoginShell: params.disableLoginShell,
      }),
    );
    const liveThreadConfigFingerprint = fingerprintCodexThreadConfig(
      {
        ...resumeParams,
        // Keep the actual loaded provider separate from caller-selected
        // overrides so account or provider changes always invalidate reuse.
        model: binding.model ?? resumeParams.model ?? null,
        requestedModel: resumeParams.model ?? null,
        modelProvider: binding.modelProvider ?? resumeParams.modelProvider ?? null,
        requestedModelProvider: resumeParams.modelProvider ?? binding.modelProvider ?? null,
      },
      resumeAuthProfileId,
      dynamicToolsFingerprint,
    );
    if (retainedThread.configFingerprint !== liveThreadConfigFingerprint) {
      // Loaded Codex threads ignore overrides; release the claimed subscription before resume.
      return { kind: "resume", prebuiltFinalConfigPatch };
    }
    await attestCodexPluginThreadApps({
      client: params.client,
      threadId: binding.threadId,
      appIds: pluginThreadConfig?.provisionalAppIds ?? [],
      signal: params.signal,
    });
    assertCurrentClient();
    const nativeHookRelayGeneration =
      prebuiltFinalConfigPatch.nativeHookRelayGeneration ?? binding.nativeHookRelayGeneration;
    const model = startModelSelection.model;
    // Validate ownership even when relay generation is unchanged; reset may
    // have replaced the persisted binding since it was first read. Model and
    // cwd are sticky turn settings, so future turns and /btw need current facts.
    const committed = await lifecycleTiming.measure("warm-thread-write-binding", () =>
      params.bindingStore.mutate(
        bindingIdentity,
        {
          kind: "patch",
          threadId: binding.threadId,
          // Environment selection is sticky turn/start state, like cwd/model;
          // recording its new value must not recreate the approval-bearing thread.
          patch: {
            cwd: params.cwd,
            model,
            nativeHookRelayGeneration,
            environmentSelectionFingerprint,
          },
        },
        assertCurrentClient,
      ),
    );
    if (!committed) {
      throw new CodexThreadBindingConflictError(binding.threadId, "committing a reused thread");
    }
    assertCurrentClient();
    lifecycleTiming.mark("thread-ready");
    lifecycleTiming.logSummary({
      runId: params.params.runId,
      sessionId: params.params.sessionId,
      sessionKey: params.params.sessionKey,
      threadId: binding.threadId,
      action: "resumed",
    });
    ownershipTransferred = true;
    return {
      kind: "ready",
      binding: {
        ...binding,
        cwd: params.cwd,
        model,
        nativeHookRelayGeneration,
        environmentSelectionFingerprint,
        liveThreadConfigFingerprint,
        liveThreadOwnership: retainedThread,
        ...(retainedThread.serviceTier && resumeParams.serviceTier === undefined
          ? { clearInheritedServiceTier: true }
          : {}),
        lifecycle: { action: "resumed" },
      },
    };
  } finally {
    if (!ownershipTransferred) {
      try {
        // Keep the claim's generation fence across policy awaits and binding conflicts.
        await retainedThread.release(binding.threadId);
      } catch (error) {
        await abandonCodexLiveThreadRelease(
          {
            client: params.client,
            abandonClient: params.abandonClient,
            lifecycleTiming,
            threadId: binding.threadId,
          },
          error,
        );
      }
    }
  }
}

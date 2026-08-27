import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  isCodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  consumeCodexAppServerLiveThread,
  releaseCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { applyCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  mergeCodexThreadConfigs,
} from "./plugin-thread-config.js";
import type { JsonObject } from "./protocol.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerThreadBinding,
} from "./session-binding.js";
import { fingerprintCodexThreadConfig } from "./thread-fingerprints.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";
import type { CodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";
import type { resolveCodexAppServerThreadModelSelection } from "./thread-model-selection.js";
import { buildThreadResumeParams } from "./thread-requests.js";

type CodexWarmThreadFinalConfigPatch = {
  configPatch?: JsonObject;
  nativeHookRelayGeneration?: string;
};

type CodexWarmThreadReuseParams = {
  params: CodexStartOrResumeThreadParams;
  binding: CodexAppServerThreadBinding;
  bindingIdentity: CodexAppServerBindingIdentity;
  clientId?: string;
  dynamicToolsFingerprint: string;
  environmentSelectionFingerprint?: string;
  hostSystemAgentActive: boolean;
  lifecycleTiming: CodexThreadLifecycleTimingTracker;
  nativeSkillIsolation?: Parameters<typeof applyCodexNativeSkillIsolation>[1];
  releaseConsumedThread: (threadId: string, cause?: unknown) => Promise<void>;
  ringZeroActive: boolean;
  restrictedToolSurfaceInheritedMcpServerNames: string[];
  startModelProvider?: string;
  startModelSelection: ReturnType<typeof resolveCodexAppServerThreadModelSelection>;
  throwIfAborted: () => void;
  userMcpServersConfigPatch?: JsonObject;
};

type CodexWarmThreadReuseResult = {
  binding?: CodexAppServerThreadLifecycleBinding;
  prebuiltFinalConfigPatch?: CodexWarmThreadFinalConfigPatch;
};

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
export async function releaseCodexRetainedLiveThread(
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
    releaseConsumedThread,
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
    return {};
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
    params.pluginThreadConfig?.enabled && binding.pluginAppPolicyContext
      ? buildCodexPluginAppsConfigPatchFromPolicyContext(binding.pluginAppPolicyContext)
      : undefined;
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
  const retainedThread = await consumeCodexAppServerLiveThread(
    params.client,
    binding.threadId,
    liveThreadConfigFingerprint,
  );
  if (!retainedThread) {
    const incompatibleOwnership = await consumeCodexAppServerLiveThread(
      params.client,
      binding.threadId,
    );
    if (incompatibleOwnership) {
      // Codex ignores resume overrides while any subscription remains. Manual
      // external adoption has no verified fingerprint, so release before resume.
      await incompatibleOwnership.release(binding.threadId);
    }
    return { prebuiltFinalConfigPatch };
  }

  try {
    const nativeHookRelayGeneration =
      prebuiltFinalConfigPatch.nativeHookRelayGeneration ?? binding.nativeHookRelayGeneration;
    const model = startModelSelection.model;
    // Validate ownership even when relay generation is unchanged; reset may
    // have replaced the persisted binding since it was first read. Model and
    // cwd are sticky turn settings, so future turns and /btw need current facts.
    const committed = await lifecycleTiming.measure("warm-thread-write-binding", () =>
      params.bindingStore.mutate(bindingIdentity, {
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
      }),
    );
    if (!committed) {
      throw new CodexThreadBindingConflictError(binding.threadId, "committing a reused thread");
    }
    throwIfAborted();
    lifecycleTiming.mark("thread-ready");
    lifecycleTiming.logSummary({
      runId: params.params.runId,
      sessionId: params.params.sessionId,
      sessionKey: params.params.sessionKey,
      threadId: binding.threadId,
      action: "resumed",
    });
    return {
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
      prebuiltFinalConfigPatch,
    };
  } catch (error) {
    await releaseConsumedThread(binding.threadId, error);
    throw error;
  }
}

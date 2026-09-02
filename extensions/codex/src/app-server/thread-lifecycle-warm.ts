import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
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
import { attestCodexThreadToolSurface } from "./plugin-thread-attestation.js";
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
import { retainCodexAppServerBindingSubscription } from "./thread-ownership.js";
import { CodexIncognitoPolicyChangeError } from "./thread-policy.js";
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
        ? captureExclusiveSharedCodexAppServerClient(client, "connection")
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
    restrictedToolSurface,
    restrictedToolSurfaceInheritedMcpServerNames,
    startModelProvider,
    startModelSelection,
    throwIfAborted,
    userMcpServersConfigPatch,
  } = options;
  const incognito = isIncognitoSessionKey(params.params.sessionKey);

  // These native-owned ephemeral lifetimes do not enter ordinary
  // configuration ownership. Keep their existing live-only continuation path.
  if (incognito && (binding.preserveNativeModel || binding.connectionScope === "supervision")) {
    if (
      binding.clientId === clientId &&
      binding.clientId &&
      ((await options.buildLoadedPluginThreadConfig(binding))?.fingerprint ??
        binding.pluginAppsFingerprint) === binding.pluginAppsFingerprint
    ) {
      params.buildFinalConfigPatch?.({ action: "resume", binding });
      throwIfAborted();
      return { kind: "ready", binding: { ...binding, lifecycle: { action: "resumed" } } };
    }
    return { kind: "rotate" };
  }

  if (
    !binding.clientId ||
    binding.clientId !== clientId ||
    binding.preserveNativeModel === true ||
    binding.connectionScope === "supervision" ||
    (ringZeroActive && !incognito)
  ) {
    return { kind: "resume" };
  }

  const retainedThread = await consumeCodexAppServerLiveThread(params.client, binding.threadId);
  if (!retainedThread) {
    return { kind: "resume" };
  }
  const assertWarmOwner = () => {
    throwIfAborted();
    // Startup attaches router abort after this lifecycle call. A closed client's
    // inventory failure must not be treated as revocation of the durable binding.
    if (!isCodexAppServerClientRuntimeLive(params.client)) {
      throw params.client.getCloseError() ?? new Error("codex app-server client is closed");
    }
    try {
      // Notifications can revoke this exact claim while its physical client stays
      // healthy. Both subscription and host authority must survive policy awaits.
      retainedThread.assertCurrent();
      params.params.hostCapabilities.assertActive();
    } catch (cause) {
      throw new AgentHarnessPreflightError(
        "Codex warm thread ownership changed before this turn could run. No turn was sent; reconnect before continuing, or start a new conversation if the original thread was closed.",
        { cause },
      );
    }
  };
  let ownershipTransferred = false;
  let preserveSubscription = false;
  try {
    assertWarmOwner();
    const pluginThreadConfig = await options.buildLoadedPluginThreadConfig(binding);
    assertWarmOwner();
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
    const liveThreadConfigFingerprint = incognito
      ? retainedThread.configFingerprint
      : fingerprintCodexThreadConfig(
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
    if (incognito && retainedThread.ephemeralPolicy !== resumeParams.developerInstructions) {
      preserveSubscription = true;
      throw new CodexIncognitoPolicyChangeError();
    }
    if (!incognito && retainedThread.configFingerprint !== liveThreadConfigFingerprint) {
      // Return the same owner first: cold-resume preparation must observe native teardown
      // before releasing it, otherwise a loaded resume can silently ignore new policy.
      preserveSubscription = true;
      return { kind: "resume", prebuiltFinalConfigPatch };
    }
    await attestCodexThreadToolSurface({
      client: params.client,
      threadId: binding.threadId,
      appIds: pluginThreadConfig?.provisionalAppIds ?? [],
      signal: params.signal,
      threadConfig: resumeParams.config,
      restrictedToolSurface,
      lifecycleTiming,
      assertCurrent: assertWarmOwner,
    });
    assertWarmOwner();
    const nativeHookRelayGeneration =
      prebuiltFinalConfigPatch.nativeHookRelayGeneration ?? binding.nativeHookRelayGeneration;
    const model = startModelSelection.model;
    // Validate ownership even when relay generation is unchanged; reset may
    // have replaced the persisted binding since it was first read. Model and
    // cwd are sticky turn settings, so future turns and /btw need current facts.
    const committed =
      incognito ||
      (await lifecycleTiming.measure("warm-thread-write-binding", () =>
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
          assertWarmOwner,
        ),
      ));
    if (!committed) {
      throw new CodexThreadBindingConflictError(binding.threadId, "committing a reused thread");
    }
    assertWarmOwner();
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
        ...(!incognito
          ? { cwd: params.cwd, model, nativeHookRelayGeneration, environmentSelectionFingerprint }
          : {}),
        liveThreadConfigFingerprint,
        liveThreadEphemeralPolicy: retainedThread.ephemeralPolicy,
        liveThreadOwnership: retainedThread,
        ...(!incognito && retainedThread.serviceTier && resumeParams.serviceTier === undefined
          ? { clearInheritedServiceTier: true }
          : {}),
        lifecycle: { action: "resumed" },
      },
    };
  } finally {
    if (!ownershipTransferred) {
      let failure: { cause: unknown } | undefined;
      try {
        if (preserveSubscription) {
          if (
            !(await retainCodexAppServerBindingSubscription(
              params.client,
              binding.threadId,
              retainedThread,
            ))
          ) {
            failure = {
              cause: new Error("Codex live thread ownership could not be returned to its session"),
            };
          }
        } else {
          // Keep the claim's generation fence across policy awaits and binding conflicts.
          await retainedThread.release(binding.threadId);
        }
      } catch (cause) {
        failure = { cause };
      }
      if (failure) {
        await abandonCodexLiveThreadRelease(
          {
            client: params.client,
            abandonClient: params.abandonClient,
            lifecycleTiming,
            threadId: binding.threadId,
          },
          failure.cause,
        );
      }
    }
  }
}

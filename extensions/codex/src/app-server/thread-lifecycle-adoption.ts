import path from "node:path";
import { isIncognitoSessionKey } from "../incognito-session.js";
import { readCodexSessionMeta } from "../session-catalog-provenance.js";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
} from "./auth-start-options.js";
import { assertCodexSessionRuntimeOwnership } from "./binding-connection.js";
import { isCodexAppServerLiveThreadClaimed } from "./client-runtime.js";
import { resolveCodexAppServerClientInstanceId } from "./client.js";
import { assertCodexThreadAcceptsDirectInput } from "./protocol-validators.js";
import { isJsonObject, type CodexThread } from "./protocol.js";
import {
  sessionBindingIdentity,
  resolveCodexSessionBinding,
  type CodexAppServerBindingIdentity,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { captureCodexAppServerClientLifetime } from "./shared-client.js";
import { shouldRotateCodexGpt56MultiAgentBinding } from "./thread-binding-policy.js";
import { isContextEngineBindingCompatible } from "./thread-context-engine.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import {
  CodexAdoptedThreadActiveError,
  CodexThreadBindingConflictError,
} from "./thread-lifecycle-errors.js";
import { resumeExistingCodexThread } from "./thread-lifecycle-io.js";
import { resolveCodexThreadAgentDir } from "./thread-lifecycle-preflight.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
  CodexThreadRequestContext,
  CodexThreadResumePreparation,
} from "./thread-lifecycle-types.js";
import { releaseCodexConsumedLiveThread } from "./thread-lifecycle-warm.js";
import {
  withCodexAppServerThreadMutation,
  withExclusiveCodexAppServerThread,
} from "./thread-ownership.js";
import { assertCodexSupervisionThreadLineage } from "./thread-policy.js";

/** Passive refusal must precede releasing or acquiring any native subscription. */
async function assertAdoptedCodexThreadResumeAllowed(
  params: CodexStartOrResumeThreadParams,
  threadId: string,
  context: Pick<CodexThreadRequestContext, "lifecycleTiming" | "throwIfAborted">,
  assertCurrent: () => void,
): Promise<CodexThread> {
  const { thread } = await context.lifecycleTiming.measure("thread-read-adoption-status", () =>
    params.client.request(
      "thread/read",
      { threadId, includeTurns: false },
      { signal: params.signal, assertCurrent },
    ),
  );
  context.throwIfAborted();
  assertCodexThreadAcceptsDirectInput(thread);
  if (thread.status?.type === "active") {
    throw new CodexAdoptedThreadActiveError();
  }
  if (thread.id !== threadId) {
    throw new Error("Codex returned another thread during adoption status read");
  }
  return thread;
}

/** All bound preparation follows attach's native-queue-before-binding-lease order. */
export async function withCodexThreadLifecycleBinding(
  params: CodexStartOrResumeThreadParams,
  run: (
    identity: CodexAppServerBindingIdentity,
    binding: CodexAppServerThreadBinding | undefined,
    assertCurrent: () => void,
  ) => Promise<CodexAppServerThreadLifecycleBinding>,
): Promise<CodexAppServerThreadLifecycleBinding> {
  const identity = sessionBindingIdentity({
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    agentId: params.agentId ?? params.params.agentId,
    config: params.params.config,
  });
  const { binding: snapshot, assertCurrent } = await resolveCodexSessionBinding({
    reclaimStale: true,
    bindingStore: params.bindingStore,
    identity,
    config: params.params.config,
    storePath: params.params.sessionTarget?.storePath,
    assertCurrent: () => {
      params.params.hostCapabilities.assertActive();
      params.assertCurrent?.();
    },
    signal: params.signal,
    assertBinding: params.params.expectedSessionRuntimeOwnership
      ? (binding) =>
          assertCodexSessionRuntimeOwnership(binding, params.params.expectedSessionRuntimeOwnership)
      : undefined,
  });
  const runWithLease = () =>
    params.bindingStore.withLease(identity, async () => {
      const binding = params.bindingStore.read(identity);
      assertCodexSessionRuntimeOwnership(binding, params.params.expectedSessionRuntimeOwnership);
      // Never prepare a replacement under the queue selected for an obsolete snapshot.
      if (binding?.threadId !== snapshot?.threadId || binding?.clientId !== snapshot?.clientId) {
        throw new CodexThreadBindingConflictError(
          binding?.threadId ?? snapshot?.threadId ?? params.params.sessionId,
          "acquiring thread lifecycle ownership",
        );
      }
      assertCurrent();
      return await run(identity, binding, assertCurrent);
    });
  // Ordinary resumes own their binding key even when a legacy row omits sessionId.
  // Foreign-owner rejection belongs to adoption, not an upgrade of that same binding.
  return snapshot?.pendingResumeConfiguration
    ? await withExclusiveCodexAppServerThread({
        bindingStore: params.bindingStore,
        identity,
        threadId: snapshot.threadId,
        run: runWithLease,
      })
    : snapshot
      ? await withCodexAppServerThreadMutation(snapshot.threadId, runWithLease)
      : await runWithLease();
}

type PendingResumeContext = CodexThreadRequestContext & {
  binding: CodexAppServerThreadBinding;
  clearCurrentBinding: (operation: string) => Promise<void>;
  releaseRetainedThread: (threadId: string, assertCurrent: () => void) => Promise<boolean>;
  transientRestriction: boolean;
};

/** Completes manual attachment only under the native queue and exact binding lease. */
export async function resumePendingCodexThread(
  params: CodexStartOrResumeThreadParams,
  context: PendingResumeContext,
): Promise<CodexAppServerThreadLifecycleBinding> {
  const { binding, contextEngineBinding, lifecycleTiming, restrictedToolSurface } = context;
  if (
    isIncognitoSessionKey(params.params.sessionKey) ||
    context.transientRestriction ||
    (!restrictedToolSurface && binding.nativeToolPolicyRestricted === true) ||
    (contextEngineBinding
      ? !isContextEngineBindingCompatible(binding.contextEngine, contextEngineBinding)
      : binding.contextEngine !== undefined) ||
    shouldRotateCodexGpt56MultiAgentBinding({
      bindingModel: binding.model,
      requestedModel: params.params.modelId,
    })
  ) {
    throw new Error(
      `Cannot configure resumed Codex thread ${binding.threadId} under a transient or incompatible session policy. ` +
        "The thread is preserved; retry from its normal session or use /new for the current policy.",
    );
  }
  const prebuiltPluginThreadConfig = params.pluginThreadConfig?.enabled
    ? await lifecycleTiming.measure("plugin-config-build", () => params.pluginThreadConfig?.build())
    : undefined;
  const clientId = resolveCodexAppServerClientInstanceId(params.client);
  const resumed = await resumeExistingCodexThread(params, {
    ...context,
    prebuiltPluginThreadConfig,
    prepareResume: () =>
      preparePendingCodexThreadResume(params, binding, context.dynamicToolsFingerprint),
    releaseRetainedThread: async (assertCurrent) => {
      const released = await context.releaseRetainedThread(binding.threadId, assertCurrent);
      assertCurrent();
      if (!released || (binding.clientId && binding.clientId !== clientId)) {
        await releaseCodexConsumedLiveThread({
          client: params.client,
          abandonClient: params.abandonClient,
          lifecycleTiming,
          threadId: binding.threadId,
          assertCurrent,
        });
      }
    },
  });
  if (!resumed) {
    throw new Error(`Codex did not configure resumed thread ${binding.threadId}.`);
  }
  return resumed;
}

/** Manual attachment is intent, never evidence that loaded native overrides took effect. */
async function preparePendingCodexThreadResume(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  dynamicToolsFingerprint: string,
): Promise<CodexThreadResumePreparation> {
  const fail = (reason: string) =>
    new Error(
      `Cannot configure resumed Codex thread ${binding.threadId}: ${reason}. ` +
        "The thread is preserved; continue it in native Codex or use /new for the current OpenClaw tools.",
    );
  const agentDir = resolveCodexThreadAgentDir(params);
  const localHome = resolveCodexAppServerLocalHomeDir(params.appServer.start, agentDir);
  if (
    params.appServer.start.transport !== "stdio" ||
    params.appServer.start.homeScope === "user" ||
    path.resolve(localHome) !== resolveCodexAppServerHomeDir(agentDir) ||
    binding.connectionScope === "supervision" ||
    binding.preserveNativeModel === true
  ) {
    throw fail("configuration adoption requires an OpenClaw-owned local Codex home");
  }
  if (isCodexAppServerLiveThreadClaimed(params.client, binding.threadId)) {
    throw fail("the thread is claimed by active work; stop that run before resuming");
  }
  const assertClient = captureCodexAppServerClientLifetime(params.client, "native-process");
  const assertCurrent = () => {
    params.params.hostCapabilities.assertActive();
    params.assertCurrent?.();
    params.signal?.throwIfAborted();
    assertClient();
    if (isCodexAppServerLiveThreadClaimed(params.client, binding.threadId)) {
      throw new CodexAdoptedThreadActiveError();
    }
  };
  assertCurrent();
  const { thread } = await params.client.request(
    "thread/read",
    { threadId: binding.threadId, includeTurns: false },
    { signal: params.signal, assertCurrent },
  );
  assertCurrent();
  if (thread.id !== binding.threadId || !isCodexThreadNonRunning(thread.status)) {
    throw fail("the native thread is not idle; wait for its current run to finish");
  }
  assertCodexThreadAcceptsDirectInput(thread);
  const observation = observeCodexThreadConfiguration(params, thread, assertCurrent);
  const dispose = observation.dispose;
  try {
    const rolloutPath = thread.path ?? binding.rolloutPath;
    const metadata = rolloutPath
      ? await readCodexSessionMeta(path.join(localHome, "sessions"), rolloutPath, binding.threadId)
      : undefined;
    if (!metadata) {
      throw fail("its native tool catalog could not be read from the selected Codex home");
    }
    // Codex restores absent/null dynamic_tools as [], and thread/resume cannot
    // replace that immutable catalog. Equality also rejects malformed tool shapes.
    const recordedTools = metadata.dynamic_tools ?? [];
    if (
      !Array.isArray(recordedTools) ||
      codexDynamicToolsFingerprint(recordedTools) !== dynamicToolsFingerprint
    ) {
      throw fail("its immutable native tool catalog does not match the current OpenClaw tools");
    }
    assertCurrent();
    return {
      assertConfigured: observation.assertConfigured,
      assertCurrent,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Observe teardown before release; a successful resume alone can acknowledge ignored overrides. */
export async function prepareCodexThreadResume(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  context: Pick<CodexThreadRequestContext, "lifecycleTiming" | "throwIfAborted">,
): Promise<CodexThreadResumePreparation> {
  const assertClient = captureCodexAppServerClientLifetime(
    params.client,
    binding.connectionScope === "supervision" ? "connection" : "native-process",
  );
  const assertCurrent = () => {
    params.params.hostCapabilities.assertActive();
    params.assertCurrent?.();
    params.signal?.throwIfAborted();
    assertClient();
    if (isCodexAppServerLiveThreadClaimed(params.client, binding.threadId)) {
      throw new CodexAdoptedThreadActiveError();
    }
  };
  assertCurrent();
  let thread: CodexThread;
  try {
    thread = await assertAdoptedCodexThreadResumeAllowed(
      params,
      binding.threadId,
      context,
      assertCurrent,
    );
  } finally {
    // A failed read cannot authorize recovery after its physical or host owner closes.
    assertCurrent();
  }
  // Known supervision keeps its native home; manual adoption's stricter home and catalog
  // checks remain in preparePendingCodexThreadResume, before this common handoff.
  assertCodexSupervisionThreadLineage(binding, thread);
  return { ...observeCodexThreadConfiguration(params, thread, assertCurrent), assertCurrent };
}

function isCodexThreadNonRunning(
  status: CodexThread["status"],
): status is Exclude<NonNullable<CodexThread["status"]>, { type: "active" }> {
  return status?.type === "idle" || status?.type === "notLoaded" || status?.type === "systemError";
}

function observeCodexThreadConfiguration(
  params: CodexStartOrResumeThreadParams,
  thread: CodexThread,
  assertCurrent: () => void,
) {
  // Codex keeps systemError after a failed turn completes; it is loaded but not running.
  // It still requires the same observed teardown before resume can change configuration.
  if (!isCodexThreadNonRunning(thread.status)) {
    throw new CodexAdoptedThreadActiveError();
  }
  let unloaded = thread.status.type === "notLoaded";
  const dispose = params.client.addNotificationHandler((notification) => {
    if (
      notification.method === "thread/status/changed" &&
      isJsonObject(notification.params) &&
      notification.params.threadId === thread.id &&
      isJsonObject(notification.params.status) &&
      notification.params.status.type === "notLoaded"
    ) {
      unloaded = true;
    }
  });
  return {
    dispose,
    assertConfigured: () => {
      assertCurrent();
      // Native resume can acknowledge ignored overrides when another subscriber
      // or failed shutdown retains the session. notLoaded proves teardown, not a
      // reservation against native-internal reloads outside OpenClaw's thread queue.
      if (!unloaded) {
        throw new Error(
          "Codex did not confirm unloading its previous configuration. The thread is preserved; stop competing native work and reconnect before retrying.",
        );
      }
    },
  };
}

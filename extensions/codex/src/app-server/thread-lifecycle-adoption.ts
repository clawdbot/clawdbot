import path from "node:path";
import { isIncognitoSessionKey } from "../incognito-session.js";
import { readCodexSessionMeta } from "../session-catalog-provenance.js";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
} from "./auth-start-options.js";
import { isCodexAppServerLiveThreadClaimed } from "./client-runtime.js";
import { resolveCodexAppServerClientInstanceId } from "./client.js";
import { assertCodexThreadAcceptsDirectInput } from "./protocol-validators.js";
import { isJsonObject, type CodexThread } from "./protocol.js";
import {
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { captureExclusiveSharedCodexAppServerClient } from "./shared-client.js";
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
} from "./thread-lifecycle-types.js";
import { releaseCodexConsumedLiveThread } from "./thread-lifecycle-warm.js";
import { withExclusiveCodexAppServerThread } from "./thread-ownership.js";
import { assertCodexSupervisionThreadLineage } from "./thread-policy.js";

/** Passive refusal must precede releasing or acquiring any native subscription. */
async function assertAdoptedCodexThreadResumeAllowed(
  params: CodexStartOrResumeThreadParams,
  threadId: string,
  context: Pick<CodexThreadRequestContext, "lifecycleTiming" | "throwIfAborted">,
): Promise<CodexThread> {
  const { thread } = await context.lifecycleTiming.measure("thread-read-adoption-status", () =>
    params.client.request(
      "thread/read",
      { threadId, includeTurns: false },
      { signal: params.signal },
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

/** Preserve attach's native-queue-before-binding-lease order when consuming pending intent. */
export async function withCodexThreadLifecycleBinding(
  params: CodexStartOrResumeThreadParams,
  run: (
    identity: CodexAppServerBindingIdentity,
    binding: CodexAppServerThreadBinding | undefined,
  ) => Promise<CodexAppServerThreadLifecycleBinding>,
): Promise<CodexAppServerThreadLifecycleBinding> {
  const identity = sessionBindingIdentity({
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    agentId: params.agentId ?? params.params.agentId,
    config: params.params.config,
  });
  const snapshot = await params.bindingStore.read(identity);
  const pendingThreadId = snapshot?.pendingResumeConfiguration ? snapshot.threadId : undefined;
  const runWithLease = () =>
    params.bindingStore.withLease(identity, async () => {
      const binding = await params.bindingStore.read(identity);
      if (
        pendingThreadId &&
        (binding?.threadId !== pendingThreadId || !binding.pendingResumeConfiguration)
      ) {
        throw new CodexThreadBindingConflictError(
          pendingThreadId,
          "acquiring a pending resume configuration",
        );
      }
      if (!pendingThreadId && binding?.pendingResumeConfiguration) {
        throw new CodexThreadBindingConflictError(
          binding.threadId,
          "acquiring a pending resume configuration",
        );
      }
      return await run(identity, binding);
    });
  return pendingThreadId
    ? await withExclusiveCodexAppServerThread({
        bindingStore: params.bindingStore,
        identity,
        threadId: pendingThreadId,
        run: runWithLease,
      })
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
  const configuration = await preparePendingCodexThreadResume(
    params,
    binding,
    context.dynamicToolsFingerprint,
    async (assertCurrent) => {
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
  );
  try {
    const resumed = await resumeExistingCodexThread(params, {
      ...context,
      prebuiltPluginThreadConfig,
      assertResumeConfiguration: configuration.assertConfigured,
      assertResumeOwnership: configuration.assertCurrent,
    });
    if (!resumed) {
      throw new Error(`Codex did not configure resumed thread ${binding.threadId}.`);
    }
    return resumed;
  } finally {
    configuration.dispose();
  }
}

/** Manual attachment is intent, never evidence that loaded native overrides took effect. */
async function preparePendingCodexThreadResume(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  dynamicToolsFingerprint: string,
  releaseSubscription: (assertCurrent: () => void) => Promise<void>,
): Promise<{ assertConfigured: () => void; assertCurrent: () => void; dispose: () => void }> {
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
  // Codex can reuse a concurrently resumed child while ignoring overrides.
  // Only an uninterrupted sole client lease makes the unload receipt conclusive.
  const assertCurrent = captureExclusiveSharedCodexAppServerClient(params.client, "native-process");
  const { thread } = await params.client.request(
    "thread/read",
    { threadId: binding.threadId, includeTurns: false },
    { signal: params.signal },
  );
  assertCurrent();
  const statusType = thread.status?.type;
  if (thread.id !== binding.threadId || (statusType !== "idle" && statusType !== "notLoaded")) {
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
    await releaseSubscription(assertCurrent);
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
) {
  if (isCodexAppServerLiveThreadClaimed(params.client, binding.threadId)) {
    throw new CodexAdoptedThreadActiveError();
  }
  const assertExclusive = captureExclusiveSharedCodexAppServerClient(
    params.client,
    binding.connectionScope === "supervision" ? "connection" : "native-process",
  );
  const assertCurrent = () => {
    params.params.hostCapabilities.assertActive();
    params.signal?.throwIfAborted();
    assertExclusive();
  };
  assertCurrent();
  const thread = await assertAdoptedCodexThreadResumeAllowed(params, binding.threadId, context);
  assertCurrent();
  // Known supervision keeps its native home; manual adoption's stricter home and catalog
  // checks remain in preparePendingCodexThreadResume, before this common handoff.
  assertCodexSupervisionThreadLineage(binding, thread);
  return { ...observeCodexThreadConfiguration(params, thread, assertCurrent), assertCurrent };
}

function observeCodexThreadConfiguration(
  params: CodexStartOrResumeThreadParams,
  thread: CodexThread,
  assertCurrent: () => void,
) {
  if (thread.status?.type !== "idle" && thread.status?.type !== "notLoaded") {
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
      // or failed shutdown retains the session. Only notLoaded proves teardown.
      if (!unloaded) {
        throw new Error(
          "Codex did not confirm unloading its previous configuration. The thread is preserved; stop competing native work and reconnect before retrying.",
        );
      }
    },
  };
}

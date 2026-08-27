import path from "node:path";
import { isIncognitoSessionKey } from "../incognito-session.js";
import { readCodexSessionMeta } from "../session-catalog-provenance.js";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
} from "./auth-start-options.js";
import { isCodexAppServerLiveThreadClaimed } from "./client-runtime.js";
import { resolveCodexAppServerClientInstanceId } from "./client.js";
import { isJsonObject } from "./protocol.js";
import {
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { captureExclusiveSharedCodexAppServerClient } from "./shared-client.js";
import { shouldRotateCodexGpt56MultiAgentBinding } from "./thread-binding-policy.js";
import { isContextEngineBindingCompatible } from "./thread-context-engine.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";
import { resolveCodexThreadAgentDir, resumeExistingCodexThread } from "./thread-lifecycle-io.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
  CodexThreadRequestContext,
} from "./thread-lifecycle-types.js";
import { releaseCodexConsumedLiveThread } from "./thread-lifecycle-warm.js";
import { withExclusiveCodexAppServerThread } from "./thread-ownership.js";

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
  const assertCurrent = captureExclusiveSharedCodexAppServerClient(params.client);
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
  let unloaded = statusType === "notLoaded";
  const dispose = params.client.addNotificationHandler((notification) => {
    if (
      notification.method === "thread/status/changed" &&
      isJsonObject(notification.params) &&
      notification.params.threadId === binding.threadId &&
      isJsonObject(notification.params.status) &&
      notification.params.status.type === "notLoaded"
    ) {
      unloaded = true;
    }
  });
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
      assertConfigured: () => {
        assertCurrent();
        // Codex 0.149.1 broadcasts notLoaded only after successful shutdown;
        // a timeout can instead acknowledge resume while ignoring every override.
        if (!unloaded) {
          throw fail("Codex did not confirm unloading its previous configuration");
        }
      },
      assertCurrent,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

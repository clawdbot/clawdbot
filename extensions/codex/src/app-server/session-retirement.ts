import type {
  AgentHarnessSessionDeletionMutation,
  AgentHarnessSessionDeletionParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
} from "./client-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
  CodexSessionGenerationRetirementResult,
} from "./session-binding.js";
import { getCodexSessionInitializationRollback } from "./session-initialization.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";
import {
  isSameCodexAppServerThreadOwner,
  withCodexAppServerThreadMutation,
} from "./thread-ownership.js";

async function releaseSessionSubscription(
  client: NonNullable<ReturnType<typeof retainSharedCodexAppServerClientByInstanceId>>["client"],
  binding: CodexAppServerThreadBinding,
  sessionKey: string | undefined,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  // End child ownership before the parent subscription, so late completions
  // cannot deliver into a replacement OpenClaw session generation.
  codexNativeSubagentMonitorRuntime.retireParent(client, binding.threadId);
  const released = await releaseCodexAppServerLiveThread(client, binding.threadId, assertCurrent);
  assertCurrent?.();
  if (!released && isIncognitoSessionKey(sessionKey)) {
    const unsubscribed = await unsubscribeCodexThreadBestEffort(client, {
      threadId: binding.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      assertCurrent,
    });
    assertCurrent?.();
    if (!unsubscribed) {
      await closeCodexStartupClientBestEffort(client);
      throw new CodexAppServerUnsafeSubscriptionError(
        `Codex retired session subscription could not be released: ${binding.threadId}`,
      );
    }
  }
}

/** Prepare exact binding deletion before the session owner commits either database. */
export async function withCodexAppServerSessionDeletion<T>(
  bindingStore: CodexAppServerBindingStore,
  params: AgentHarnessSessionDeletionParams,
  run: (mutation: AgentHarnessSessionDeletionMutation) => Promise<T>,
): Promise<T> {
  const { assertCurrent } = params;
  const identity = {
    kind: "session" as const,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  };
  const remove = () =>
    bindingStore.withSessionDeletion(identity, assertCurrent, async (binding, mutation) => {
      assertCurrent();
      const rollbackInitialization = getCodexSessionInitializationRollback(
        bindingStore,
        params,
        identity,
        binding,
      );
      if (binding?.connectionScope === "supervision" && !rollbackInitialization) {
        throw new Error("Cannot delete a session while its Codex binding is owned by supervision");
      }
      const clientLease = binding?.clientId
        ? retainSharedCodexAppServerClientByInstanceId(binding.clientId)
        : undefined;
      const assertUnclaimed = () => {
        assertCurrent();
        if (
          clientLease &&
          binding &&
          isCodexAppServerLiveThreadClaimed(clientLease.client, binding.threadId)
        ) {
          throw new Error(
            "Cannot delete a session while its Codex thread is claimed by active work",
          );
        }
      };
      let committed = false;
      try {
        assertUnclaimed();
        return await run({
          commit() {
            assertUnclaimed();
            mutation.commit();
            committed = true;
          },
          rollback() {
            mutation.rollback();
            committed = false;
          },
        });
      } finally {
        try {
          if (committed && rollbackInitialization) {
            assertCurrent();
            await rollbackInitialization();
          }
          // An artifact publication failure after COMMIT still ends this subscription;
          // only the session owner's transaction rollback may restore the binding.
          if (committed && binding && clientLease) {
            await withCodexAppServerThreadMutation(binding.threadId, async () => {
              assertCurrent();
              // Most expired bindings no longer have a live subscription. Only
              // live threads need the persisted-owner check (idle retention is bounded).
              if (
                !hasCodexAppServerLiveThread(clientLease.client, binding.threadId) &&
                !isIncognitoSessionKey(params.sessionKey)
              ) {
                return;
              }
              // The deleted row is absent now. Any surviving owner, including a
              // successor at the same key, keeps its connection-scoped subscription.
              if (await bindingStore.hasOtherThreadOwner(binding.threadId)) {
                return;
              }
              await releaseSessionSubscription(
                clientLease.client,
                binding,
                params.sessionKey,
                assertUnclaimed,
              );
            });
          }
        } finally {
          clientLease?.release();
        }
      }
    });
  return params.initialization ? await bindingStore.withThreadArchiveFence(remove) : await remove();
}

/** Retire binding and native subscription under the same generation/physical-client ownership fence. */
export async function retireCodexAppServerSessionGeneration(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  mode: "reset" | "retire";
}): Promise<CodexSessionGenerationRetirementResult> {
  const retireGeneration = () =>
    params.mode === "reset"
      ? params.bindingStore.resetSessionGeneration(params.identity)
      : params.bindingStore.retireSessionGeneration(params.identity);
  const expectedBinding = await params.bindingStore.read(params.identity);
  if (!expectedBinding) {
    // Leasing an absent/retired row manufactures state or rejects its fence;
    // callers need the original absent/conflict result for reset reclamation.
    return await retireGeneration();
  }
  return await withCodexAppServerThreadMutation(expectedBinding.threadId, () =>
    params.bindingStore.withLease(params.identity, async () => {
      const binding = await params.bindingStore.read(params.identity);
      if (!binding || !isSameCodexAppServerThreadOwner(binding, expectedBinding)) {
        return "conflict";
      }
      const result = await retireGeneration();
      if (result !== "applied" || !binding?.clientId) {
        return result;
      }

      // Locate the original physical client only after its exact binding was
      // retired; delayed reset events must never unsubscribe a newer generation.
      const clientLease = retainSharedCodexAppServerClientByInstanceId(binding.clientId);
      if (!clientLease) {
        return result;
      }
      try {
        await releaseSessionSubscription(clientLease.client, binding, params.identity.sessionKey);
      } finally {
        clientLease.release();
      }
      return result;
    }),
  );
}

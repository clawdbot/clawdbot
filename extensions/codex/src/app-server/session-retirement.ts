import { isIncognitoSessionKey } from "../incognito-session.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { releaseCodexAppServerLiveThread } from "./client-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexSessionGenerationRetirementResult,
} from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";

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
  return await params.bindingStore.withLease(params.identity, async () => {
    const binding = await params.bindingStore.read(params.identity);
    if (binding?.threadId !== expectedBinding.threadId) {
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
      // Reset retires native-child ownership before unsubscribing its parent;
      // late child completions must never reach a replacement session generation.
      codexNativeSubagentMonitorRuntime.retireParent(clientLease.client, binding.threadId);
      const released = await releaseCodexAppServerLiveThread(clientLease.client, binding.threadId);
      if (!released && isIncognitoSessionKey(params.identity.sessionKey)) {
        // Ephemeral threads have no rollout to resume, so they intentionally
        // bypass idle eviction but still end with their owning OpenClaw session.
        const unsubscribed = await unsubscribeCodexThreadBestEffort(clientLease.client, {
          threadId: binding.threadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        });
        if (!unsubscribed) {
          await closeCodexStartupClientBestEffort(clientLease.client);
          throw new CodexAppServerUnsafeSubscriptionError(
            `Codex retired session subscription could not be released: ${binding.threadId}`,
          );
        }
      }
    } finally {
      clientLease.release();
    }
    return result;
  });
}

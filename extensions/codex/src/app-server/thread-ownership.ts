import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
  type CodexAppServerLiveThreadOwnership,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
} from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";

const nativeThreadOwners = new KeyedAsyncQueue();

/** Serialize connection-scoped unsubscribe with attach/resume of the same native thread. */
export async function withCodexAppServerThreadMutation<T>(
  threadId: string,
  run: () => Promise<T>,
): Promise<T> {
  return await nativeThreadOwners.enqueue(`thread:${threadId}`, run);
}

/** Codex subscriptions belong to a physical connection, not the native thread ID alone. */
export function isSameCodexAppServerThreadOwner(
  current: Pick<CodexAppServerThreadBinding, "threadId" | "clientId"> | undefined,
  expected: Pick<CodexAppServerThreadBinding, "threadId" | "clientId"> | undefined,
): boolean {
  return (
    current !== undefined &&
    expected !== undefined &&
    current.threadId === expected.threadId &&
    current.clientId === expected.clientId
  );
}

/** Fences native subscription and commit together; Codex subscriptions are not reference-counted. */
export async function withExclusiveCodexAppServerThread<T>(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  threadId: string;
  run: () => Promise<T>;
}): Promise<T> {
  return await withCodexAppServerThreadMutation(params.threadId, async () => {
    if (await params.bindingStore.hasOtherThreadOwner(params.threadId, params.identity)) {
      throw new Error(
        `Codex thread ${params.threadId} is owned by another OpenClaw session or conversation.`,
      );
    }
    return await params.run();
  });
}

/** Serializes bound turns and retirement so detach cannot unsubscribe an active turn. */
export async function withCodexConversationThreadActivity<T>(
  bindingId: string,
  run: () => Promise<T>,
): Promise<T> {
  return await nativeThreadOwners.enqueue(`conversation:${bindingId}`, run);
}

/** Publishes one owned persistent subscription into the shared bounded idle registry. */
export async function retainCodexAppServerBindingSubscription(
  client: CodexAppServerClient,
  threadId: string,
  ownership?: Partial<CodexAppServerLiveThreadOwnership>,
): Promise<boolean> {
  return await retainCodexAppServerLiveThread(
    client,
    threadId,
    ownership?.release ??
      (async (releasedThreadId, assertCurrent) => {
        const unsubscribed = await unsubscribeCodexThreadBestEffort(client, {
          threadId: releasedThreadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
          assertCurrent,
        });
        if (!unsubscribed) {
          assertCurrent?.();
          await closeCodexStartupClientBestEffort(client);
          throw new CodexAppServerUnsafeSubscriptionError(
            `Codex thread subscription could not be released: ${releasedThreadId}`,
          );
        }
      }),
    ownership?.configFingerprint,
    ownership?.serviceTier,
  );
}

/** Rolls back the exact subscription Codex created before its binding was committed. */
export async function rollbackCodexAppServerBindingSubscription(
  client: CodexAppServerClient,
  threadId: string,
  retained: boolean,
): Promise<void> {
  if (retained && (await releaseCodexAppServerLiveThread(client, threadId))) {
    return;
  }
  // Failed retention can mean another generation already owns this exact
  // subscription; resume did not create a second connection-scoped listener.
  if (isCodexAppServerLiveThreadClaimed(client, threadId)) {
    return;
  }
  // Start/resume subscribes before its response; failed retention has no
  // registry owner, so the responding physical client must unsubscribe it.
  if (
    !(await unsubscribeCodexThreadBestEffort(client, {
      threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    }))
  ) {
    await closeCodexStartupClientBestEffort(client);
  }
}

/** Releases only the physical client and native thread recorded by the displaced binding owner. */
export async function releaseCodexAppServerBindingSubscription(
  binding: Pick<CodexAppServerThreadBinding, "threadId" | "clientId">,
  options: { allowUntracked?: boolean; assertCurrent?: () => void } = {},
): Promise<void> {
  options.assertCurrent?.();
  const clientLease = retainSharedCodexAppServerClientByInstanceId(binding.clientId);
  if (!clientLease) {
    return;
  }
  try {
    if (
      await releaseCodexAppServerLiveThread(
        clientLease.client,
        binding.threadId,
        options.assertCurrent,
      )
    ) {
      return;
    }
    options.assertCurrent?.();
    // Evicted idle owners also disappear from the registry. Only an explicit
    // claimed generation proves an active turn still owns its subscription.
    if (isCodexAppServerLiveThreadClaimed(clientLease.client, binding.threadId)) {
      throw new Error(
        `Codex thread ${binding.threadId} has an active run; stop it before changing its owner.`,
      );
    }
    if (!options.allowUntracked) {
      return;
    }
    const unsubscribed = await unsubscribeCodexThreadBestEffort(clientLease.client, {
      threadId: binding.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      assertCurrent: options.assertCurrent,
    });
    if (!unsubscribed) {
      await closeCodexStartupClientBestEffort(clientLease.client);
      throw new CodexAppServerUnsafeSubscriptionError(
        `Codex retired thread subscription could not be released: ${binding.threadId}`,
      );
    }
  } finally {
    clientLease.release();
  }
}

/** Clears and releases one exact conversation generation without touching its replacement. */
export async function retireCodexConversationThreadBinding(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: Extract<CodexAppServerBindingIdentity, { kind: "conversation" }>;
  expectedThreadId?: string;
  expectedStartId?: string;
  allowUntracked?: boolean;
  afterClear?: () => Promise<void>;
}): Promise<boolean> {
  const expected = await params.bindingStore.read(params.identity);
  if (!expected || (params.expectedThreadId && expected.threadId !== params.expectedThreadId)) {
    return false;
  }
  return await params.bindingStore.withLease(params.identity, async () => {
    const current = await params.bindingStore.read(params.identity);
    if (
      current?.threadId !== expected.threadId ||
      (params.expectedStartId && current.conversationStartId !== params.expectedStartId)
    ) {
      return false;
    }
    // Keep the old row authoritative through unsubscribe; Codex has one
    // subscription per physical client, so clearing first races a new owner.
    await releaseCodexAppServerBindingSubscription(current, {
      allowUntracked: params.allowUntracked,
    });
    const cleared = await params.bindingStore.mutate(params.identity, {
      kind: "clear",
      threadId: current.threadId,
    });
    if (!cleared || !params.afterClear) {
      return cleared;
    }
    try {
      await params.afterClear();
      return true;
    } catch (error) {
      try {
        // Public binding storage commits separately. Restore its exact native
        // owner on failure without ever overwriting a replacement generation.
        const restored = await params.bindingStore.mutate(params.identity, {
          kind: "set",
          binding: current,
          if: { kind: "absent" },
        });
        if (!restored) {
          throw new Error("the previous Codex binding generation could not be restored", {
            cause: error,
          });
        }
      } catch (restorationError) {
        const recoveryError = new AggregateError(
          [error, restorationError],
          `Codex conversation detachment failed and native thread ${current.threadId} could not be restored; run /codex resume ${current.threadId} to recover it`,
          { cause: restorationError },
        );
        throw recoveryError;
      }
      throw error;
    }
  });
}

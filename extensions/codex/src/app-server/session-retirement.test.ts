import { randomUUID } from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyCodexConversationBindingId } from "../conversation-binding-data.js";
import {
  claimCodexAppServerLiveThread,
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
} from "./client-runtime.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { withCodexAppServerSessionDeletion } from "./session-retirement.js";
import * as sharedClients from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import {
  retainCodexAppServerBindingSubscription,
  withCodexAppServerThreadMutation,
  withExclusiveCodexAppServerThread,
} from "./thread-ownership.js";
import { withTimeout } from "./timeout.js";

const session = {
  kind: "session" as const,
  agentId: "main",
  sessionKey: "agent:main:dashboard:retirement",
  sessionId: "session-before-deletion",
};

describe("Codex session deletion subscriptions", () => {
  const clients: ReturnType<typeof createClientHarness>[] = [];

  afterEach(() => {
    for (const harness of clients) {
      harness.client.close();
      harness.emitExit();
    }
    clients.length = 0;
    vi.restoreAllMocks();
  });

  function createFixture() {
    const harness = createClientHarness();
    clients.push(harness);
    const { client } = harness;
    const bindingStore = createCodexTestBindingStore();
    const binding = {
      threadId: `thread-${randomUUID()}`,
      clientId: client.getInstanceId(),
      cwd: "/repo",
    };
    const request = vi.spyOn(client, "request").mockResolvedValue({ status: "unsubscribed" });
    const releaseClientLease = vi.fn();
    vi.spyOn(sharedClients, "retainSharedCodexAppServerClientByInstanceId").mockImplementation(
      (clientId) =>
        clientId === binding.clientId ? { client, release: releaseClientLease } : undefined,
    );
    ensureCodexAppServerClientRuntime(client, {
      agentDir: "/tmp/codex-retirement-agent",
      authMode: "prepared-api-key",
    });

    const seed = async (identity = session) => {
      await bindingStore.mutate(identity, { kind: "set", binding });
    };
    const remove = (
      identity = session,
      run: Parameters<typeof withCodexAppServerSessionDeletion<void>>[2] = async (mutation) => {
        mutation.commit();
      },
    ) =>
      withCodexAppServerSessionDeletion(
        bindingStore,
        { ...identity, assertCurrent: () => {} },
        run,
      );
    const resume = async (identity: typeof session) => {
      await bindingStore.withLease(identity, async () => {
        await client.request("thread/resume", { threadId: binding.threadId });
        await retainCodexAppServerBindingSubscription(client, binding.threadId);
        if (!(await bindingStore.mutate(identity, { kind: "set", binding }))) {
          throw new Error("resumed binding did not commit");
        }
      });
    };
    return { bindingStore, binding, client, remove, request, resume, seed };
  }

  it("rejects a claimed native thread before invoking the session transaction", async () => {
    const fixture = createFixture();
    await fixture.seed();
    await claimCodexAppServerLiveThread(fixture.client, fixture.binding.threadId);
    const transaction = vi.fn(async () => {});

    await expect(fixture.remove(session, transaction)).rejects.toThrow("claimed by active work");

    expect(transaction).not.toHaveBeenCalled();
    expect(fixture.bindingStore.read(session)).toEqual(fixture.binding);
    expect(isCodexAppServerLiveThreadClaimed(fixture.client, fixture.binding.threadId)).toBe(true);
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("removes a migrated session binding without unsubscribing its surviving legacy conversation", async () => {
    const fixture = createFixture();
    const conversation = {
      kind: "conversation" as const,
      bindingId: legacyCodexConversationBindingId("/repo/legacy-session.jsonl"),
    };
    await fixture.seed();
    await fixture.bindingStore.mutate(conversation, { kind: "set", binding: fixture.binding });
    await retainCodexAppServerBindingSubscription(fixture.client, fixture.binding.threadId);

    await fixture.remove();

    expect(fixture.bindingStore.read(session)).toBeUndefined();
    expect(fixture.bindingStore.read(conversation)).toEqual(fixture.binding);
    expect(
      await consumeCodexAppServerLiveThread(fixture.client, fixture.binding.threadId),
    ).toBeDefined();
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("preserves a same-key successor when resume owns the native queue before deletion cleanup", async () => {
    const fixture = createFixture();
    await fixture.seed();
    await retainCodexAppServerBindingSubscription(fixture.client, fixture.binding.threadId);
    const successor = { ...session, sessionId: "session-after-deletion" };
    const resumeEntered = createDeferred<void>();
    const allowResume = createDeferred<void>();
    const committed = createDeferred<void>();
    const resuming = withCodexAppServerThreadMutation(fixture.binding.threadId, async () => {
      resumeEntered.resolve();
      await allowResume.promise;
      await fixture.resume(successor);
    });
    await withTimeout(resumeEntered.promise, 5_000, "resume did not enter the native queue");
    const deletion = fixture.remove(session, async (mutation) => {
      mutation.commit();
      committed.resolve();
    });
    const completion = Promise.allSettled([resuming, deletion]);
    try {
      await withTimeout(committed.promise, 5_000, "native resume queue blocked session deletion");
      allowResume.resolve();
      expect(
        await withTimeout(completion, 5_000, "native deletion cleanup did not settle"),
      ).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(fixture.bindingStore.read(successor)).toEqual(fixture.binding);
      expect(
        await consumeCodexAppServerLiveThread(fixture.client, fixture.binding.threadId),
      ).toBeDefined();
      expect(fixture.request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    } finally {
      allowResume.resolve();
      await withTimeout(completion, 5_000, "resume and deletion cleanup did not settle");
    }
  });

  it("holds the native queue through unsubscribe acknowledgement before a successor resumes", async () => {
    const fixture = createFixture();
    await fixture.seed();
    await retainCodexAppServerBindingSubscription(fixture.client, fixture.binding.threadId);
    const unsubscribeStarted = createDeferred<void>();
    const unsubscribeAcknowledged = createDeferred<void>();
    fixture.request.mockImplementation(async (method) => {
      if (method === "thread/unsubscribe") {
        unsubscribeStarted.resolve();
        await unsubscribeAcknowledged.promise;
      }
      return {};
    });
    const deletion = fixture.remove();
    const deletionCompletion = Promise.allSettled([deletion]);
    let resuming: Promise<void> | undefined;
    try {
      await withTimeout(unsubscribeStarted.promise, 5_000, "deletion did not unsubscribe");
      const successor = { ...session, sessionId: "session-after-deletion" };
      let resumeEntered = false;
      resuming = withExclusiveCodexAppServerThread({
        bindingStore: fixture.bindingStore,
        identity: successor,
        threadId: fixture.binding.threadId,
        run: async () => {
          resumeEntered = true;
          await fixture.resume(successor);
        },
      });
      const completion = Promise.allSettled([deletion, resuming]);
      await withCodexAppServerThreadMutation(`other-${fixture.binding.threadId}`, async () => {});
      expect(resumeEntered).toBe(false);
      expect(fixture.bindingStore.read(session)).toBeUndefined();
      unsubscribeAcknowledged.resolve();
      expect(
        await withTimeout(completion, 5_000, "resume did not follow deletion cleanup"),
      ).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/unsubscribe",
        "thread/resume",
      ]);
      expect(fixture.bindingStore.read(successor)).toEqual(fixture.binding);
      expect(hasCodexAppServerLiveThread(fixture.client, fixture.binding.threadId)).toBe(true);
    } finally {
      unsubscribeAcknowledged.resolve();
      await withTimeout(
        Promise.allSettled([deletionCompletion, resuming]),
        5_000,
        "unsubscribe and resume cleanup did not settle",
      );
    }
  });

  it("deletes nested same-thread owners without deadlock and releases their subscription once", async () => {
    const fixture = createFixture();
    const sibling = { ...session, sessionKey: "agent:main:cron:retirement:run:child" };
    await fixture.seed();
    await fixture.seed(sibling);
    await retainCodexAppServerBindingSubscription(fixture.client, fixture.binding.threadId);

    await withTimeout(
      fixture.remove(session, async (first) => {
        await fixture.remove(sibling, async (second) => {
          first.commit();
          second.commit();
        });
      }),
      5_000,
      "nested deletion deadlocked on a shared native thread",
    );

    expect(fixture.bindingStore.read(session)).toBeUndefined();
    expect(fixture.bindingStore.read(sibling)).toBeUndefined();
    expect(fixture.request.mock.calls.map(([method]) => method)).toEqual(["thread/unsubscribe"]);
    expect(hasCodexAppServerLiveThread(fixture.client, fixture.binding.threadId)).toBe(false);
  });

  it("unsubscribes an incognito thread without an idle registry entry", async () => {
    const fixture = createFixture();
    const incognito = { ...session, sessionKey: "agent:main:dashboard:incognito-retirement" };
    await fixture.seed(incognito);

    await fixture.remove(incognito);

    expect(fixture.bindingStore.read(incognito)).toBeUndefined();
    expect(fixture.request).toHaveBeenCalledExactlyOnceWith(
      "thread/unsubscribe",
      { threadId: fixture.binding.threadId },
      { timeoutMs: 5_000, assertCurrent: expect.any(Function) },
    );
  });
});

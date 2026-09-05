import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateIdentity,
  MemoryAuditStore,
  MemoryReplayStore,
  type Verdict,
} from "../protocol/index.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  envelope,
  flowStores,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
  transport,
  trust,
} from "./flow.test-helpers.js";
import { reefPeerIdentity } from "./friend-types.js";
import { ReefFriendManager } from "./friends.js";
import { createReefRuntimeAuthority } from "./runtime.js";
import { ReefInboxConnection, type ReefTransportClient } from "./transport.js";
import type { InboxEntry } from "./types.js";
import { encodeReefWorkflowMessage, registerReefWorkflowInbox } from "./workflow-inbox.js";
import { classifyReefWorkflowSendError, sendReefWorkflowMessage } from "./workflow-runtime.js";

const disposers: Array<() => void> = [];
beforeEach(resetFlowStoresForTests);
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  resetFlowStoresForTests();
});

function setup(verdict: Verdict = allow) {
  const alice = generateIdentity();
  const bob = reefKeys();
  const relay = transport();
  const onIngress = vi.fn(async () => {});
  const onOwnerNotice = vi.fn(async () => {});
  const classifier = guard(verdict);
  const trusted = trust({ alice: peerTrust(alice, { autonomy: "extended" }) });
  const stores = flowStores();
  const flow = new ReefMessageFlow({
    config: config(),
    trust: trusted.store,
    keys: bob,
    transport: relay as unknown as ReefTransportClient,
    guard: classifier,
    audit: new MemoryAuditStore(new Uint8Array(32).fill(11)),
    replay: new MemoryReplayStore(),
    ...stores,
    onIngress,
    onOwnerNotice,
  });
  const expectedPeer = reefPeerIdentity(peerTrust(alice));
  const entry = async (seq = 1, messageId = `operation-${seq}`): Promise<InboxEntry> => {
    const id = `01JZ000000000000000000${String(seq).padStart(4, "0")}`;
    const text = encodeReefWorkflowMessage({
      protocol: "example.support.v2",
      messageId,
      payload: { caseId: "case-1" },
    });
    return {
      seq,
      peer: "alice",
      id,
      kind: "message",
      envelope: await envelope(alice, bob, id, text),
      ts: Math.floor(Date.now() / 1000),
    };
  };
  return {
    ...stores,
    alice,
    bob,
    relay,
    flow,
    entry,
    expectedPeer,
    onIngress,
    onOwnerNotice,
    classifier,
    trusted,
  };
}

describe("Reef workflow inbox delivery", () => {
  it.each([
    { decision: "review", category: "policy", expected: "review-pending" },
    { decision: "deny", category: "policy", expected: "rejected" },
    { decision: "deny", category: "guard_failure", expected: "retryable" },
  ] as const)(
    "classifies outbound $category/$decision for the application outbox",
    async ({ decision, category, expected }) => {
      const s = setup({ ...allow, decision, category });
      const error = await s.flow
        .send("alice", "workflow evidence")
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(classifyReefWorkflowSendError(error)).toBe(expected);
      expect(s.relay.sendEnvelope).not.toHaveBeenCalled();
    },
  );

  it("commits through the registered inbox before ack and bypasses chat budgets only for workflows", async () => {
    const s = setup();
    const accepted = new Set<string>();
    disposers.push(
      registerReefWorkflowInbox({
        protocol: "example.support.v2",
        peer: "alice",
        expectedPeer: s.expectedPeer,
        accept: async (message) => {
          accepted.add(message.transportMessageId);
          return { accepted: true };
        },
      }),
    );
    s.relay.acknowledge.mockImplementation(async (_peer, id) => {
      expect(accepted.has(id)).toBe(true);
      await expect(s.delivered.has(id)).resolves.toBe(true);
      return { result: "deleted" };
    });
    for (let seq = 1; seq <= 13; seq++) await s.flow.processEntries([await s.entry(seq)]);
    expect(accepted.size).toBe(13);
    expect(s.onIngress).not.toHaveBeenCalled();
    expect(s.onOwnerNotice).not.toHaveBeenCalled();
    expect(s.classifier.classify).toHaveBeenCalledTimes(13);
    s.relay.acknowledge.mockImplementation(async () => ({ result: "deleted" }));
    const id = "01JZ0000000000000000000100";
    await s.flow.processEntries([
      {
        seq: 100,
        peer: "alice",
        id,
        kind: "message",
        envelope: await envelope(s.alice, s.bob, id, "ordinary chat"),
        ts: Math.floor(Date.now() / 1000),
      },
    ]);
    expect(s.onIngress).toHaveBeenCalledOnce();
  });

  it("holds the transport cursor and ack on failed admission, then retries across inbox registration restart", async () => {
    const s = setup();
    const message = await s.entry();
    const cursors: number[] = [];
    const client = {
      pull: async (after: number) => ({ entries: after === 0 ? [message] : [], cursor: 1 }),
    } as unknown as ReefTransportClient;
    const connection = new ReefInboxConnection(
      client,
      async (entries) => {
        await s.flow.processEntries(entries);
      },
      () => {
        throw new Error("unused socket");
      },
      { persistCursor: (cursor) => cursors.push(cursor) },
    );
    const stop = registerReefWorkflowInbox({
      protocol: "example.support.v2",
      peer: "alice",
      expectedPeer: s.expectedPeer,
      accept: async () => ({ accepted: false }),
    });
    disposers.push(stop);
    await connection.drain();
    expect(cursors).toEqual([]);
    expect(s.relay.acknowledge).not.toHaveBeenCalled();
    await expect(s.delivered.has(message.id)).resolves.toBe(false);
    stop();
    await connection.drain();
    const accept = vi.fn(async () => ({ accepted: true }));
    disposers.push(
      registerReefWorkflowInbox({
        protocol: "example.support.v2",
        peer: "alice",
        expectedPeer: s.expectedPeer,
        accept,
      }),
    );
    await connection.drain();
    await s.flow.processEntries([message]);
    expect(cursors).toEqual([1]);
    expect(accept).toHaveBeenCalledOnce();
    expect(s.relay.acknowledge).toHaveBeenCalledTimes(2);
    expect(s.onIngress).not.toHaveBeenCalled();
  });

  it("does not acknowledge while a durable inbox commit is still pending or rejects", async () => {
    const s = setup();
    let reject!: (error: Error) => void;
    const commit = new Promise<{ accepted: boolean }>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const accept = vi.fn(() => commit);
    disposers.push(
      registerReefWorkflowInbox({
        protocol: "example.support.v2",
        peer: "alice",
        expectedPeer: s.expectedPeer,
        accept,
      }),
    );
    const pending = s.flow.processEntries([await s.entry()]);
    const outcome = expect(pending).rejects.toThrow("inbox commit failed");
    await vi.waitFor(() => expect(accept).toHaveBeenCalledOnce());
    expect(s.relay.acknowledge).not.toHaveBeenCalled();
    reject(new Error("database unavailable"));
    await outcome;
    expect(s.relay.acknowledge).not.toHaveBeenCalled();
  });

  it.each(["deny", "review"] as const)(
    "preserves guard %s before workflow admission",
    async (decision) => {
      const s = setup({ ...allow, decision, category: "policy" });
      const accept = vi.fn(async () => ({ accepted: true }));
      disposers.push(
        registerReefWorkflowInbox({
          protocol: "example.support.v2",
          peer: "alice",
          expectedPeer: s.expectedPeer,
          accept,
        }),
      );
      const task = s.flow.processEntries([await s.entry()]);
      if (decision === "review") {
        await expect(task).rejects.toThrow("review approval pending");
        expect(s.relay.acknowledge).not.toHaveBeenCalled();
        expect(await s.reviews.list()).toHaveLength(1);
      } else {
        await task;
        expect(s.relay.acknowledge.mock.calls[0]?.[2].status).toBe("rejected");
      }
      expect(accept).not.toHaveBeenCalled();
      expect(s.onIngress).not.toHaveBeenCalled();
    },
  );

  it("defers a valid trusted sender whose identity does not match the registered workflow pin", async () => {
    const s = setup();
    const accept = vi.fn(async () => ({ accepted: true }));
    disposers.push(
      registerReefWorkflowInbox({
        protocol: "example.support.v2",
        peer: "alice",
        expectedPeer: reefPeerIdentity(peerTrust(generateIdentity())),
        accept,
      }),
    );
    await expect(s.flow.processEntries([await s.entry()])).rejects.toThrow("inbox unavailable");
    expect(accept).not.toHaveBeenCalled();
    expect(s.relay.acknowledge).not.toHaveBeenCalled();
  });

  it("retains application operation identity across new transport attempts", async () => {
    const s = setup();
    const operations = new Set<string>();
    const transports = new Set<string>();
    disposers.push(
      registerReefWorkflowInbox({
        protocol: "example.support.v2",
        peer: "alice",
        expectedPeer: s.expectedPeer,
        accept: async (message) => {
          operations.add(message.messageId);
          transports.add(message.transportMessageId);
          return { accepted: true };
        },
      }),
    );
    await s.flow.processEntries([
      await s.entry(1, "same-operation"),
      await s.entry(2, "same-operation"),
    ]);
    expect(operations.size).toBe(1);
    expect(transports.size).toBe(2);
  });

  it("rejects oversized or non-JSON payloads before sending", () => {
    expect(() =>
      encodeReefWorkflowMessage({
        protocol: "example.support.v2",
        messageId: "id",
        payload: "x".repeat(32 * 1024),
      }),
    ).toThrow("32 KiB");
    expect(() =>
      encodeReefWorkflowMessage({
        protocol: "example.support.v2",
        messageId: "id",
        payload: undefined,
      }),
    ).toThrow();
    // JSON text is escaped a second time inside the encrypted MessageBody.
    expect(() =>
      encodeReefWorkflowMessage({
        protocol: "example.support.v2",
        messageId: "id",
        payload: '"'.repeat(10_000),
      }),
    ).toThrow("32 KiB");
  });

  it("sends the public runtime API through trust, guard, encryption and durable receiving admission", async () => {
    const s = setup();
    const receiverTrust = trust({ bob: peerTrust(s.bob) });
    const receiverRelay = transport();
    const received: string[] = [];
    const receiver = new ReefMessageFlow({
      config: { ...config(), handle: "alice" },
      trust: receiverTrust.store,
      keys: reefKeys(s.alice),
      transport: receiverRelay as unknown as ReefTransportClient,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(12)),
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {
        throw new Error("workflow reached ordinary chat");
      },
      onOwnerNotice: async () => {
        throw new Error("workflow reached owner notification");
      },
    });
    disposers.push(
      registerReefWorkflowInbox({
        protocol: "example.support.v2",
        peer: "bob",
        expectedPeer: reefPeerIdentity(peerTrust(s.bob)),
        accept: async (message) => {
          received.push(message.messageId);
          return { accepted: true };
        },
      }),
    );
    const relay = s.relay as unknown as ReefTransportClient;
    const authority = createReefRuntimeAuthority();
    disposers.push(() => authority.release());
    authority.activate({
      flow: s.flow,
      friends: new ReefFriendManager(relay, s.trusted.store, {
        list: async () => [],
        remove: async () => false,
      }),
      reviews: s.reviews,
    });
    s.relay.sendEnvelope.mockImplementation(async (_peer, value) => {
      await receiver.processEntries([
        {
          seq: 1,
          peer: "bob",
          id: value.id,
          kind: "message",
          envelope: value,
          ts: Math.floor(Date.now() / 1000),
        },
      ]);
      return { id: value.id, status: "queued" };
    });
    const result = await sendReefWorkflowMessage({
      protocol: "example.support.v2",
      peer: "alice",
      expectedPeer: s.expectedPeer,
      messageId: "operation-runtime",
      payload: { caseId: "case-2" },
    });
    expect(result.status).toBe("queued");
    expect(received).toEqual(["operation-runtime"]);
    expect(s.classifier.classify).toHaveBeenCalledOnce();
    expect(receiverRelay.acknowledge.mock.calls[0]?.[2]).toMatchObject({
      id: result.transportMessageId,
      status: "accepted",
    });
    authority.release();
    await expect(
      sendReefWorkflowMessage({
        protocol: "example.support.v2",
        peer: "alice",
        expectedPeer: s.expectedPeer,
        messageId: "operation-runtime",
        payload: {},
      }),
    ).rejects.toThrow("not running");
  });
});

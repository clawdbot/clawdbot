import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalBytes,
  composeOutbound,
  generateIdentity,
  MemoryAuditStore,
  MemoryReplayStore,
  sha256Hex,
  signReceipt,
  type AuditEntry,
} from "../protocol/index.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  flowStores,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
  transport,
  trust,
} from "./flow.test-helpers.js";
import { reefPeerIdentity } from "./friend-types.js";
import { processReefInboxEntriesInOrder, ReefReceiptNotifier } from "./owner-notice.js";
import type { ReefTransportClient } from "./transport.js";
import {
  REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
  REEF_OUTBOUND_DELIVERY_TTL_MS,
} from "./trust-store.js";
import type { InboxEntry } from "./types.js";

beforeEach(resetFlowStoresForTests);
afterEach(resetFlowStoresForTests);

describe("ReefMessageFlow delivery receipts", () => {
  it("quarantines an unmatched forged receipt without scanning audit history", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(17));
    const entries = vi.spyOn(audit, "entries");
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trust({ alice: peerTrust(alice) }).store,
      keys: bob,

      transport: transport() as unknown as ReefTransportClient,
      guard: guard(allow),
      audit,
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    const id = "01JZ0000000000000000000130";
    const receipt = signReceipt(
      {
        id,
        bodyHash: "a".repeat(64),
        auditHead: "b".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      bob.signing.secretKey,
    );

    await expect(
      flow.processEntries([{ seq: 1, peer: "alice", id, kind: "receipt", receipt, ts: 1 }]),
    ).resolves.toEqual([]);
    expect(entries).not.toHaveBeenCalled();
  });

  it("confirms a recent pre-binding accepted receipt only once", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const trusted = trust({ alice: peerTrust(alice) });
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(15));
    const id = "01JZ0000000000000000000127";
    const text = "queued before delivery bindings";
    await composeOutbound({
      id,
      from: "bob#1",
      to: "alice#1",
      body: { text },
      senderSigningSecretKey: bob.signing.secretKey,
      recipientEncryptionPublicKey: alice.encryption.publicKey,
      guard: guard(allow),
      audit,
      policyVersion: "v1",
    });
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trusted.store,
      keys: bob,

      transport: transport() as unknown as ReefTransportClient,
      guard: guard(allow),
      audit,
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    const receipt = signReceipt(
      {
        id,
        bodyHash: sha256Hex(canonicalBytes({ text })),
        auditHead: "a".repeat(64),
        status: "accepted",
      },
      alice.signing.secretKey,
    );
    const entry: InboxEntry = { seq: 1, peer: "alice", id, kind: "receipt", receipt, ts: 1 };

    await expect(flow.processEntries([entry])).resolves.toEqual([]);
    await expect(flow.processEntries([{ ...entry, seq: 2 }])).resolves.toEqual([]);

    const events = (await audit.entries()).map((item) => item.event.type);
    expect(events.filter((type) => type === "confirm_delivery")).toHaveLength(1);
    expect(events.filter((type) => type === "invalid_delivery_receipt")).toHaveLength(1);
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(false);
  });

  it("does not let abandoned proposals evict sealed legacy deliveries", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(18));
    const id = "01JZ0000000000000000000132";
    const bodyHash = "a".repeat(64);
    const ts = Math.floor(Date.now() / 1_000);
    const entries: AuditEntry[] = [
      {
        event: { seq: 1, ts, type: "proposal", payload: { id, to: "alice#1", bodyHash } },
        prevHash: "",
        entryHash: "",
      },
      {
        event: {
          seq: 2,
          ts,
          type: "proposal",
          payload: { id: "abandoned-0", to: "alice#1", bodyHash },
        },
        prevHash: "",
        entryHash: "",
      },
      ...Array.from({ length: REEF_OUTBOUND_DELIVERY_MAX_ENTRIES - 1 }, (_, index) => ({
        event: {
          seq: index + 3,
          ts,
          type: "proposal",
          payload: { id: `abandoned-${index + 1}`, to: "alice#1", bodyHash },
        },
        prevHash: "",
        entryHash: "",
      })),
      {
        event: {
          seq: REEF_OUTBOUND_DELIVERY_MAX_ENTRIES + 2,
          ts,
          type: "envelope",
          payload: { id },
        },
        prevHash: "",
        entryHash: "",
      },
    ];
    vi.spyOn(audit, "entries").mockResolvedValueOnce(entries);
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trust({ alice: peerTrust(alice) }).store,
      keys: bob,

      transport: transport() as unknown as ReefTransportClient,
      guard: guard(allow),
      audit,
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    const receipt = signReceipt(
      {
        id,
        bodyHash,
        auditHead: "b".repeat(64),
        status: "accepted",
      },
      alice.signing.secretKey,
    );

    await expect(
      flow.processEntries([{ seq: 1, peer: "alice", id, kind: "receipt", receipt, ts: 1 }]),
    ).resolves.toEqual([]);
    expect(
      (await audit.entries()).filter((entry) => entry.event.type === "confirm_delivery"),
    ).toHaveLength(1);
  });

  it("anchors legacy recovery retention to envelope sealing", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(20));
    const id = "01JZ0000000000000000000135";
    const bodyHash = "a".repeat(64);
    const sealedAt = Math.floor(Date.now() / 1_000);
    const proposedAt = sealedAt - Math.ceil(REEF_OUTBOUND_DELIVERY_TTL_MS / 1_000) - 1;
    const entries: AuditEntry[] = [
      {
        event: {
          seq: 1,
          ts: proposedAt,
          type: "proposal",
          payload: { id, to: "alice#1", bodyHash },
        },
        prevHash: "",
        entryHash: "",
      },
      {
        event: { seq: 2, ts: sealedAt, type: "envelope", payload: { id } },
        prevHash: "",
        entryHash: "",
      },
    ];
    vi.spyOn(audit, "entries").mockResolvedValueOnce(entries);
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trust({ alice: peerTrust(alice) }).store,
      keys: bob,

      transport: transport() as unknown as ReefTransportClient,
      guard: guard(allow),
      audit,
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    const receipt = signReceipt(
      {
        id,
        bodyHash,
        auditHead: "b".repeat(64),
        status: "accepted",
      },
      alice.signing.secretKey,
    );

    await flow.processEntries([
      { seq: 1, peer: "alice", id, kind: "receipt", receipt, ts: sealedAt },
    ]);

    expect(
      (await audit.entries()).filter((entry) => entry.event.type === "confirm_delivery"),
    ).toHaveLength(1);
  });

  it("expires candidates after a cached legacy index ages out", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const trusted = trust({ alice: peerTrust(alice) });
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(19));
    const id = "01JZ0000000000000000000133";
    const missId = "01JZ0000000000000000000134";
    const bodyHash = "a".repeat(64);
    const now = Date.now();
    const ts = Math.floor(now / 1_000);
    const entries: AuditEntry[] = [
      {
        event: { seq: 1, ts, type: "proposal", payload: { id, to: "alice#1", bodyHash } },
        prevHash: "",
        entryHash: "",
      },
      {
        event: { seq: 2, ts, type: "envelope", payload: { id } },
        prevHash: "",
        entryHash: "",
      },
    ];
    const auditEntries = vi.spyOn(audit, "entries").mockResolvedValueOnce(entries);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trusted.store,
      keys: bob,

      transport: transport() as unknown as ReefTransportClient,
      guard: guard(allow),
      audit,
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    const miss = signReceipt(
      {
        id: missId,
        bodyHash,
        auditHead: "b".repeat(64),
        status: "accepted",
      },
      alice.signing.secretKey,
    );
    const receipt = signReceipt(
      {
        id,
        bodyHash,
        auditHead: "c".repeat(64),
        status: "accepted",
      },
      alice.signing.secretKey,
    );

    try {
      await flow.processEntries([
        { seq: 1, peer: "alice", id: missId, kind: "receipt", receipt: miss, ts: 1 },
      ]);
      nowSpy.mockReturnValue(now + REEF_OUTBOUND_DELIVERY_TTL_MS + 1_000);
      await flow.processEntries([{ seq: 2, peer: "alice", id, kind: "receipt", receipt, ts: 1 }]);
    } finally {
      nowSpy.mockRestore();
    }

    expect(auditEntries).toHaveBeenCalledOnce();
    expect(
      (await audit.entries()).filter((entry) => entry.event.type === "confirm_delivery"),
    ).toHaveLength(0);
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(false);
  });

  it("surfaces a recent pre-binding rejection as durable stop-only guidance", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const trusted = trust({ alice: peerTrust(alice) });
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(16));
    const id = "01JZ0000000000000000000128";
    const text = "queued rejection before delivery bindings";
    await composeOutbound({
      id,
      from: "bob#1",
      to: "alice#1",
      body: { text },
      senderSigningSecretKey: bob.signing.secretKey,
      recipientEncryptionPublicKey: alice.encryption.publicKey,
      guard: guard(allow),
      audit,
      policyVersion: "v1",
    });
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trusted.store,
      keys: bob,

      transport: transport() as unknown as ReefTransportClient,
      guard: guard(allow),
      audit,
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    const receipt = signReceipt(
      {
        id,
        bodyHash: sha256Hex(canonicalBytes({ text })),
        auditHead: "b".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      alice.signing.secretKey,
    );
    const rejections = await flow.processEntries([
      { seq: 1, peer: "alice", id, kind: "receipt", receipt, ts: 1 },
    ]);
    const notify = vi.fn(async () => {});
    const receiptNotifier = new ReefReceiptNotifier(notify, {
      loadState: (peer) => trusted.store.rejectionNoticeState(peer),
      reserve: (rejection, noticeState) =>
        trusted.store.reserveOutboundRejectionNotice(
          rejection.peer,
          rejection.id,
          rejection.recipient,
          noticeState,
        ),
      complete: (rejection, noticeState) => {
        if (!trusted.store.completeOutboundRejection(rejection.peer, rejection.id, noticeState)) {
          throw new Error(`missing rejection ${rejection.id}`);
        }
      },
    });

    await receiptNotifier.notifyRejections(rejections);

    expect(rejections).toEqual([
      {
        id,
        peer: "alice",
        recipient: reefPeerIdentity(peerTrust(alice)),
        category: "guard_deny",
        reservedNotice: { lastRejectionAt: expect.any(Number) },
      },
    ]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: "alice",
        messageId: id,
        allowResend: false,
        text: expect.stringMatching(/Stop automatic retries/),
      }),
    );
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(false);
  });

  it("surfaces one resend notice even when a later batch receipt is invalid", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const onOwnerNotice = vi.fn(async () => {});
    const relay = transport();
    const trusted = trust({ alice: peerTrust(alice) });
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(11));
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trusted.store,
      keys: bob,

      transport: relay as unknown as ReefTransportClient,
      guard: guard(allow),
      audit,
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    const receiptNotifier = new ReefReceiptNotifier(onOwnerNotice, {
      loadState: (peer) => trusted.store.rejectionNoticeState(peer),
      reserve: (rejection, noticeState) =>
        trusted.store.reserveOutboundRejectionNotice(
          rejection.peer,
          rejection.id,
          rejection.recipient,
          noticeState,
        ),
      complete: (rejection, noticeState) => {
        if (!trusted.store.completeOutboundRejection(rejection.peer, rejection.id, noticeState)) {
          throw new Error(`missing rejection ${rejection.id}`);
        }
      },
    });
    const id = await flow.send("alice", "ordinary coordination");
    const receipt = signReceipt(
      {
        id,
        bodyHash: sha256Hex(canonicalBytes({ text: "ordinary coordination" })),
        auditHead: "b".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      alice.signing.secretKey,
    );
    const entry: InboxEntry = {
      seq: 1,
      peer: "alice",
      id,
      kind: "receipt",
      receipt,
      ts: Math.floor(Date.now() / 1_000),
    };
    const invalidEntry: InboxEntry = {
      seq: 2,
      peer: "alice",
      id: "01JZ0000000000000000000106",
      kind: "receipt",
      receipt: signReceipt(
        {
          id: "01JZ0000000000000000000106",
          bodyHash: "c".repeat(64),
          auditHead: "d".repeat(64),
          status: "rejected",
          category: "guard_deny",
        },
        bob.signing.secretKey,
      ),
      ts: Math.floor(Date.now() / 1_000),
    };
    const acceptedId = await flow.send("alice", "later coordination");
    const acceptedEntry: InboxEntry = {
      seq: 3,
      peer: "alice",
      id: acceptedId,
      kind: "receipt",
      receipt: signReceipt(
        {
          id: acceptedId,
          bodyHash: sha256Hex(canonicalBytes({ text: "later coordination" })),
          auditHead: "e".repeat(64),
          status: "accepted",
        },
        alice.signing.secretKey,
      ),
      ts: Math.floor(Date.now() / 1_000),
    };

    await expect(
      processReefInboxEntriesInOrder({
        entries: [entry, invalidEntry, acceptedEntry],
        processEntries: (batch) => flow.processEntries(batch),
        notifyRejections: (rejections) => receiptNotifier.notifyRejections(rejections),
      }),
    ).resolves.toBeUndefined();
    await expect(
      processReefInboxEntriesInOrder({
        entries: [
          { ...entry, seq: 4 },
          { ...invalidEntry, seq: 5 },
        ],
        processEntries: (batch) => flow.processEntries(batch),
        notifyRejections: (rejections) => receiptNotifier.notifyRejections(rejections),
      }),
    ).resolves.toBeUndefined();

    expect(onOwnerNotice).toHaveBeenCalledOnce();
    expect(onOwnerNotice).toHaveBeenCalledWith({
      text: expect.stringMatching(/rejected by the peer's inbound guard.*at most once/),
      peer: "alice",
      messageId: id,
      recipient: reefPeerIdentity(peerTrust(alice)),
      originalTextHash: receipt.bodyHash,
      allowResend: true,
    });
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(false);
    expect(trusted.deliveries.has(`alice:${acceptedId}`)).toBe(false);
    expect(trusted.rejectionNotices.get("alice")).toEqual({
      lastRejectionAt: expect.any(Number),
      lastResendAt: expect.any(Number),
    });
    expect(
      (await audit.entries()).filter((item) => item.event.type === "invalid_delivery_receipt"),
    ).toHaveLength(3);
  });

  it("does not recover a signed rejection from an unsealed outbound proposal", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const trusted = trust({ alice: peerTrust(alice) });
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(12));
    const auditEntries = vi.spyOn(audit, "entries");
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trusted.store,
      keys: bob,

      transport: transport() as unknown as ReefTransportClient,
      guard: guard(allow),
      audit,
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    const id = "01JZ0000000000000000000113";
    const receipt = signReceipt(
      {
        id,
        bodyHash: "a".repeat(64),
        auditHead: "b".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      alice.signing.secretKey,
    );
    await audit.appendEvent("proposal", {
      id,
      from: "bob#1",
      to: "alice#1",
      bodyHash: receipt.bodyHash,
    });

    await expect(
      flow.processEntries([{ seq: 1, peer: "alice", id, kind: "receipt", receipt, ts: 1 }]),
    ).resolves.toEqual([]);
    const otherId = "01JZ0000000000000000000131";
    const otherReceipt = signReceipt(
      {
        id: otherId,
        bodyHash: receipt.bodyHash,
        auditHead: "c".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      alice.signing.secretKey,
    );
    await expect(
      flow.processEntries([
        { seq: 2, peer: "alice", id: otherId, kind: "receipt", receipt: otherReceipt, ts: 1 },
      ]),
    ).resolves.toEqual([]);
    expect(auditEntries).toHaveBeenCalledOnce();
    const events = (await audit.entries()).map((entry) => entry.event.type);
    expect(events).toContain("invalid_delivery_receipt");
    expect(events).not.toContain("confirm_delivery");
  });

  it("binds receipts and automatic resends to the send-time recipient identity", async () => {
    const alice = generateIdentity();
    const rotatedAlice = generateIdentity();
    const bob = reefKeys();
    const originalTrust = peerTrust(alice);
    const originalRecipient = reefPeerIdentity(originalTrust);
    const trusted = trust({ alice: originalTrust });
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(14));
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trusted.store,
      keys: bob,

      transport: transport() as unknown as ReefTransportClient,
      guard: guard(allow),
      audit,
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    const id = await flow.send("alice", "expected body");
    const bodyHash = sha256Hex(canonicalBytes({ text: "expected body" }));
    trusted.values.set("alice", peerTrust(rotatedAlice, { keyEpoch: 2 }));

    await expect(
      flow.send("alice", "automatic retry", {
        replyTo: id,
        expectedRecipient: originalRecipient,
      }),
    ).rejects.toThrow("not approved with current keys");

    const rotatedReceipt = signReceipt(
      {
        id,
        bodyHash,
        auditHead: "c".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      rotatedAlice.signing.secretKey,
    );
    await expect(
      flow.processEntries([
        { seq: 1, peer: "alice", id, kind: "receipt", receipt: rotatedReceipt, ts: 1 },
      ]),
    ).resolves.toEqual([]);
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(true);
    expect(
      (await audit.entries()).filter((entry) => entry.event.type === "confirm_delivery"),
    ).toHaveLength(0);

    const originalReceipt = signReceipt(
      {
        id,
        bodyHash,
        auditHead: "d".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      alice.signing.secretKey,
    );
    await expect(
      flow.processEntries([
        { seq: 2, peer: "alice", id, kind: "receipt", receipt: originalReceipt, ts: 1 },
      ]),
    ).resolves.toEqual([]);
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(false);
    expect(
      (await audit.entries()).filter((entry) => entry.event.type === "confirm_delivery"),
    ).toHaveLength(1);
  });

  it("quarantines peer-signed receipt conflicts without consuming outbound state", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const trusted = trust({ alice: peerTrust(alice) });
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(13));
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trusted.store,
      keys: bob,

      transport: transport() as unknown as ReefTransportClient,
      guard: guard(allow),
      audit,
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });
    const id = await flow.send("alice", "expected body");
    const receipt = signReceipt(
      {
        id,
        bodyHash: "c".repeat(64),
        auditHead: "d".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      alice.signing.secretKey,
    );

    await expect(
      flow.processEntries([{ seq: 1, peer: "alice", id, kind: "receipt", receipt, ts: 1 }]),
    ).resolves.toEqual([]);
    expect(trusted.deliveries.has(`alice:${id}`)).toBe(true);

    const bodyHash = sha256Hex(canonicalBytes({ text: "expected body" }));
    const rejected = signReceipt(
      {
        id,
        bodyHash,
        auditHead: "e".repeat(64),
        status: "rejected",
        category: "guard_deny",
      },
      alice.signing.secretKey,
    );
    await expect(
      flow.processEntries([
        { seq: 2, peer: "alice", id, kind: "receipt", receipt: rejected, ts: 1 },
      ]),
    ).resolves.toEqual([
      {
        id,
        peer: "alice",
        recipient: reefPeerIdentity(peerTrust(alice)),
        textHash: bodyHash,
        category: "guard_deny",
      },
    ]);

    const conflictingAccepted = signReceipt(
      {
        id,
        bodyHash,
        auditHead: "f".repeat(64),
        status: "accepted",
      },
      alice.signing.secretKey,
    );
    await expect(
      flow.processEntries([
        { seq: 3, peer: "alice", id, kind: "receipt", receipt: conflictingAccepted, ts: 1 },
      ]),
    ).resolves.toEqual([]);
    expect(trusted.deliveries.get(`alice:${id}`)?.rejection).toEqual({
      category: "guard_deny",
    });
    expect(
      (await audit.entries()).filter((item) => item.event.type === "invalid_delivery_receipt"),
    ).toHaveLength(2);

    const appendEvent = audit.appendEvent.bind(audit);
    vi.spyOn(audit, "appendEvent").mockImplementation(async (type, payload, ts) => {
      if (type === "invalid_delivery_receipt") {
        throw new Error("audit unavailable");
      }
      return await appendEvent(type, payload, ts);
    });
    await expect(
      flow.processEntries([
        { seq: 4, peer: "alice", id, kind: "receipt", receipt: conflictingAccepted, ts: 1 },
      ]),
    ).rejects.toThrow("audit unavailable");
    expect(trusted.deliveries.get(`alice:${id}`)?.rejection).toEqual({
      category: "guard_deny",
    });
  });
});

describe("ReefMessageFlow overdue delivery follow-up", () => {
  it("notifies the owner when an accepted receipt closes an overdue notice", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const trusted = trust({ alice: peerTrust(alice) });
    const relay = transport();
    const onOwnerNotice = vi.fn(async (_text: string) => {});
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trusted.store,
      keys: bob,
      transport: relay as unknown as ReefTransportClient,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(23)),
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice,
    });
    const id = await flow.send("alice", "are you there?");
    const record = trusted.deliveries.get(`alice:${id}`)!;
    record.overdueNotifiedAt = Date.now();
    const receipt = signReceipt(
      { id, bodyHash: record.bodyHash, auditHead: "a".repeat(64), status: "accepted" },
      alice.signing.secretKey,
    );

    await expect(
      flow.processEntries([{ seq: 1, peer: "alice", id, kind: "receipt", receipt, ts: 1 }]),
    ).resolves.toEqual([]);

    expect(trusted.deliveries.has(`alice:${id}`)).toBe(false);
    expect(onOwnerNotice).toHaveBeenCalledOnce();
    expect(onOwnerNotice.mock.calls[0]?.[0]).toContain("delivered after");
  });

  it("stays silent for accepted receipts that were never reported overdue", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const trusted = trust({ alice: peerTrust(alice) });
    const relay = transport();
    const onOwnerNotice = vi.fn(async (_text: string) => {});
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trusted.store,
      keys: bob,
      transport: relay as unknown as ReefTransportClient,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(24)),
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice,
    });
    const id = await flow.send("alice", "quick ping");
    const record = trusted.deliveries.get(`alice:${id}`)!;
    const receipt = signReceipt(
      { id, bodyHash: record.bodyHash, auditHead: "a".repeat(64), status: "accepted" },
      alice.signing.secretKey,
    );

    await expect(
      flow.processEntries([{ seq: 1, peer: "alice", id, kind: "receipt", receipt, ts: 1 }]),
    ).resolves.toEqual([]);
    expect(onOwnerNotice).not.toHaveBeenCalled();
  });
});

import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { ReefPeerIdentity } from "./friend-types.js";
import {
  createReefOwnerNoticeHandler,
  processReefInboxEntriesInOrder,
  ReefReceiptNotifier,
} from "./owner-notice.js";
import type { InboxEntry, ReefDeliveryRejection, ReefRejectionNoticeState } from "./types.js";

type ReefRejectionNotice = Parameters<ConstructorParameters<typeof ReefReceiptNotifier>[0]>[0];

const recipient: ReefPeerIdentity = {
  ed25519PublicKey: "A".repeat(43),
  x25519PublicKey: "B".repeat(43),
  keyEpoch: 1,
};

function rejection(peer: string, id: string, category = "guard_deny"): ReefDeliveryRejection {
  return { peer, id, recipient, textHash: "a".repeat(64), category };
}

async function consumeNotice(_notice: ReefRejectionNotice): Promise<void> {}

function createNoticeStore() {
  const records = new Map<
    string,
    { peer: string; phase: "reserved" | "consumed"; state: ReefRejectionNoticeState }
  >();
  const key = (value: ReefDeliveryRejection) => `${value.peer}:${value.id}`;
  const store: ConstructorParameters<typeof ReefReceiptNotifier>[1] = {
    loadState: (peer) => {
      let latest: ReefRejectionNoticeState | undefined;
      for (const record of records.values()) {
        if (record.peer !== peer) {
          continue;
        }
        const hasResendAt =
          latest?.lastResendAt !== undefined || record.state.lastResendAt !== undefined;
        latest = {
          lastRejectionAt: Math.max(latest?.lastRejectionAt ?? 0, record.state.lastRejectionAt),
          ...(hasResendAt
            ? {
                lastResendAt: Math.max(latest?.lastResendAt ?? 0, record.state.lastResendAt ?? 0),
              }
            : {}),
        };
      }
      return latest;
    },
    reserve: (value, state) => {
      const existing = records.get(key(value));
      if (existing) {
        return { kind: "existing", state: existing.state };
      }
      records.set(key(value), {
        peer: value.peer,
        phase: "reserved",
        state: { ...state },
      });
      return { kind: "reserved" };
    },
    complete: (value, state) => {
      const recordKey = key(value);
      const existing = records.get(recordKey);
      if (!existing) {
        throw new Error(`missing notice reservation ${value.id}`);
      }
      records.set(recordKey, { ...existing, phase: "consumed", state: { ...state } });
    },
  };
  return { records, store };
}

describe("createReefOwnerNoticeHandler", () => {
  it("queues a generic owner notice in the peer session and wakes on request", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.channel.routing.resolveAgentRoute).mockReturnValue({
      agentId: "main",
      channel: "reef",
      accountId: "default",
      sessionKey: "agent:main:reef:direct:alice",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
    vi.mocked(runtime.system.enqueueSystemEvent).mockReturnValue(true);
    const notify = createReefOwnerNoticeHandler({
      runtime,
      cfg: {},
      accountId: "default",
      handle: "bob",
    });

    await notify({
      text: "owner notice",
      peer: "alice",
      contextKey: "reef:owner:alice",
      wakeAgent: true,
    });

    expect(runtime.system.enqueueSystemEvent).toHaveBeenCalledWith("owner notice", {
      sessionKey: "agent:main:reef:direct:alice",
      contextKey: "reef:owner:alice",
    });
    expect(runtime.system.requestHeartbeat).toHaveBeenCalledWith({
      source: "other",
      intent: "immediate",
      reason: "reef:delivery-rejected",
      agentId: "main",
      sessionKey: "agent:main:reef:direct:alice",
    });
  });

  it("does not wake when the generic notice is already queued", async () => {
    const runtime = createPluginRuntimeMock();
    vi.mocked(runtime.system.enqueueSystemEvent).mockReturnValue(false);
    const notify = createReefOwnerNoticeHandler({
      runtime,
      cfg: {},
      accountId: "default",
      handle: "bob",
    });

    await notify({ text: "owner notice", contextKey: "reef:owner:bob", wakeAgent: true });

    expect(runtime.system.requestHeartbeat).not.toHaveBeenCalled();
  });
});

describe("processReefInboxEntriesInOrder", () => {
  it("advances the full batch when a receipt notice fails", async () => {
    const order: string[] = [];
    const onNoticeError = vi.fn();
    const message = { id: "message", kind: "message" } as InboxEntry;
    const receipt = { id: "receipt", kind: "receipt" } as InboxEntry;
    const later = { id: "later", kind: "message" } as InboxEntry;

    await processReefInboxEntriesInOrder({
      entries: [message, receipt, later],
      processEntries: async ([entry]) => {
        order.push(`process:${entry!.id}`);
        return entry === receipt ? [rejection("alice", entry.id)] : [];
      },
      notifyRejections: async ([deliveryRejection]) => {
        order.push(`notice:${deliveryRejection?.id ?? "none"}`);
        if (deliveryRejection?.id === receipt.id) {
          throw new Error("notice failed");
        }
      },
      onNoticeError,
    });

    expect(order).toEqual([
      "process:message",
      "notice:none",
      "process:receipt",
      "notice:receipt",
      "process:later",
      "notice:none",
    ]);
    expect(onNoticeError).toHaveBeenCalledOnce();
  });
});

describe("ReefReceiptNotifier", () => {
  it("extends the resend cooldown from every rejection", async () => {
    const notify = vi.fn(consumeNotice);
    const notices = createNoticeStore();
    let now = 10_000;
    const notifier = new ReefReceiptNotifier(notify, notices.store, { now: () => now });
    const first = rejection("alice", "01JZ0000000000000000000105");
    const second = rejection("alice", "01JZ0000000000000000000107");
    const third = rejection("alice", "01JZ0000000000000000000108");
    const later = rejection("alice", "01JZ0000000000000000000109");

    await notifier.notifyRejections([first, first]);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: expect.stringMatching(/at most once.*stop and wait for owner guidance/i),
      peer: "alice",
      messageId: first.id,
      allowResend: true,
    });
    now += 14 * 60 * 1_000;
    await notifier.notifyRejections([second]);
    expect(notify.mock.calls[1]![0]).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries/),
      allowResend: false,
    });

    now += 2 * 60 * 1_000;
    await notifier.notifyRejections([third]);
    expect(notify.mock.calls[2]![0]).toMatchObject({ allowResend: false });

    now += 15 * 60 * 1_000;
    await notifier.notifyRejections([later]);
    expect(notify.mock.calls[3]![0]).toMatchObject({ allowResend: true });
  });

  it("never grants a resend for non-guard rejection categories", async () => {
    const notify = vi.fn(consumeNotice);
    const notifier = new ReefReceiptNotifier(notify, createNoticeStore().store, {
      now: () => 10_000,
    });

    await notifier.notifyRejections([
      rejection("alice", "01JZ0000000000000000000110", "deterministic_deny"),
    ]);

    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries/),
      allowResend: false,
    });
  });

  it("never grants a resend without a send-time text fingerprint", async () => {
    const notify = vi.fn(consumeNotice);
    const notifier = new ReefReceiptNotifier(notify, createNoticeStore().store, {
      now: () => 10_000,
    });
    const pending = rejection("alice", "01JZ0000000000000000000130");

    await notifier.notifyRejections([{ ...pending, textHash: undefined }]);

    expect(notify.mock.calls[0]![0]).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries/),
      allowResend: false,
    });
  });

  it("keeps resend cooldowns across notifier recreation", async () => {
    const notices = createNoticeStore();
    const first = new ReefReceiptNotifier(consumeNotice, notices.store, { now: () => 10_000 });
    await first.notifyRejections([rejection("alice", "01JZ0000000000000000000105")]);

    expect(notices.store.loadState("alice")).toEqual({
      lastRejectionAt: 10_000,
      lastResendAt: 10_000,
    });

    const notify = vi.fn(consumeNotice);
    const restarted = new ReefReceiptNotifier(notify, notices.store, { now: () => 11_000 });
    await restarted.notifyRejections([rejection("alice", "01JZ0000000000000000000107")]);

    expect(notify.mock.calls[0]![0]).toMatchObject({ allowResend: false });
  });

  it("applies later recovered reservations before fresh items in the same batch", async () => {
    const notices = createNoticeStore();
    const recovered = rejection("alice", "01JZ0000000000000000000111");
    const reservedNotice = { lastRejectionAt: 10_000, lastResendAt: 10_000 };
    notices.store.reserve(recovered, reservedNotice);
    const notify = vi.fn(consumeNotice);
    const notifier = new ReefReceiptNotifier(notify, notices.store, { now: () => 11_000 });

    await notifier.notifyRejections([
      rejection("alice", "01JZ0000000000000000000112"),
      { ...recovered, reservedNotice },
    ]);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![0]).toMatchObject({ allowResend: false });
    expect(notify.mock.calls[1]![0]).toMatchObject({ allowResend: false });
  });

  it("fails closed when recovered cooldown state cannot be loaded", async () => {
    const notices = createNoticeStore();
    const recovered = rejection("alice", "01JZ0000000000000000000116");
    const reservedNotice = { lastRejectionAt: 10_000, lastResendAt: 10_000 };
    notices.store.reserve(recovered, reservedNotice);
    const loadError = new Error("state unavailable");
    vi.spyOn(notices.store, "loadState").mockImplementationOnce(() => {
      throw loadError;
    });
    const notify = vi.fn(consumeNotice);
    const onError = vi.fn();
    const notifier = new ReefReceiptNotifier(notify, notices.store, {
      now: () => 1_000_000,
      onError,
    });

    await notifier.notifyRejections([
      rejection("alice", "01JZ0000000000000000000117"),
      { ...recovered, reservedNotice },
    ]);

    expect(onError).toHaveBeenCalledWith(loadError, recovered.id);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![0]).toMatchObject({ allowResend: false });
    expect(notify.mock.calls[1]![0]).toMatchObject({ allowResend: false });
  });

  it("keeps cached cooldown time monotonic after a backward clock adjustment", async () => {
    const notices = createNoticeStore();
    const previous = rejection("alice", "01JZ0000000000000000000113", "deterministic_deny");
    notices.store.reserve(previous, { lastRejectionAt: 1_000_000 });
    notices.store.complete(previous, { lastRejectionAt: 1_000_000 });
    const notify = vi.fn(consumeNotice);
    let now = 900_000;
    const notifier = new ReefReceiptNotifier(notify, notices.store, { now: () => now });

    await notifier.notifyRejections([rejection("alice", "01JZ0000000000000000000114")]);
    now = 1_800_000;
    await notifier.notifyRejections([rejection("alice", "01JZ0000000000000000000115")]);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![0]).toMatchObject({ allowResend: false });
    expect(notify.mock.calls[1]![0]).toMatchObject({ allowResend: false });
  });

  it("retries a fresh rejection after durable state loading fails", async () => {
    const notices = createNoticeStore();
    const loadError = new Error("state unavailable");
    vi.spyOn(notices.store, "loadState").mockImplementationOnce(() => {
      throw loadError;
    });
    const notify = vi.fn(consumeNotice);
    const onError = vi.fn();
    const scheduled: Array<() => Promise<void>> = [];
    const notifier = new ReefReceiptNotifier(notify, notices.store, {
      onError,
      schedule: (task) => scheduled.push(task),
    });
    const pending = rejection("alice", "01JZ0000000000000000000124");

    await notifier.notifyRejections([pending]);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!();

    expect(onError).toHaveBeenCalledWith(loadError, pending.id);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("keeps a failed dispatch reserved and retries with stop-only guidance", async () => {
    const notices = createNoticeStore();
    const notify = vi.fn(consumeNotice).mockRejectedValueOnce(new Error("dispatch interrupted"));
    const scheduled: Array<() => Promise<void>> = [];
    const notifier = new ReefReceiptNotifier(notify, notices.store, {
      now: () => 10_000,
      schedule: (task) => scheduled.push(task),
    });
    const pending = rejection("alice", "01JZ0000000000000000000109");

    await notifier.notifyRejections([pending]);
    expect(notices.records.get(`${pending.peer}:${pending.id}`)?.phase).toBe("reserved");
    expect(scheduled).toHaveLength(1);

    await scheduled[0]!();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).toMatchObject({
      text: expect.stringMatching(/Stop automatic retries/),
      allowResend: false,
    });
    expect(notices.records.get(`${pending.peer}:${pending.id}`)?.phase).toBe("consumed");
  });

  it("keeps retrying recovery with bounded backoff until dispatch succeeds", async () => {
    const notices = createNoticeStore();
    const pending = rejection("alice", "01JZ0000000000000000000125");
    const reservedNotice = { lastRejectionAt: 10_000, lastResendAt: 10_000 };
    notices.store.reserve(pending, reservedNotice);
    const notify = vi
      .fn(consumeNotice)
      .mockRejectedValueOnce(new Error("dispatch unavailable"))
      .mockRejectedValueOnce(new Error("dispatch still unavailable"));
    const scheduled: Array<{ task: () => Promise<void>; delayMs: number }> = [];
    const notifier = new ReefReceiptNotifier(notify, notices.store, {
      schedule: (task, delayMs) => scheduled.push({ task, delayMs }),
    });
    const recovered = { ...pending, reservedNotice };

    await notifier.notifyRejections([recovered]);
    expect(scheduled[0]?.delayMs).toBe(1_000);
    await scheduled[0]!.task();
    expect(scheduled[1]?.delayMs).toBe(2_000);
    await scheduled[1]!.task();

    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[2]![0]).toMatchObject({ allowResend: false });
    expect(notices.records.get(`${pending.peer}:${pending.id}`)?.phase).toBe("consumed");
  });

  it("caps persistent retry delay and stops the old notifier after abort", async () => {
    const notices = createNoticeStore();
    const notify = vi.fn(consumeNotice).mockRejectedValue(new Error("dispatch unavailable"));
    const scheduled: Array<{ task: () => Promise<void>; delayMs: number }> = [];
    const abort = new AbortController();
    const notifier = new ReefReceiptNotifier(notify, notices.store, {
      signal: abort.signal,
      schedule: (task, delayMs) => scheduled.push({ task, delayMs }),
    });

    await notifier.notifyRejections([rejection("alice", "01JZ0000000000000000000126")]);
    for (let index = 0; index < 7; index += 1) {
      await scheduled[index]!.task();
    }

    expect(scheduled.map((entry) => entry.delayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
    abort.abort();
    await scheduled[7]!.task();
    expect(notify).toHaveBeenCalledTimes(8);
    expect(scheduled).toHaveLength(8);
  });

  it("retries durable completion without dispatching the agent twice", async () => {
    const notices = createNoticeStore();
    const originalComplete = notices.store.complete.bind(notices.store);
    const complete = vi.spyOn(notices.store, "complete").mockImplementationOnce(() => {
      throw new Error("state unavailable");
    });
    complete.mockImplementation(originalComplete);
    const notify = vi.fn(consumeNotice);
    const scheduled: Array<() => Promise<void>> = [];
    const notifier = new ReefReceiptNotifier(notify, notices.store, {
      schedule: (task) => scheduled.push(task),
    });

    await notifier.notifyRejections([rejection("alice", "01JZ0000000000000000000114")]);
    await scheduled[0]!();

    expect(notify).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("recovers a crash after agent consumption without granting another resend", async () => {
    const notices = createNoticeStore();
    const complete = vi.spyOn(notices.store, "complete").mockImplementationOnce(() => {
      throw new Error("process interrupted after dispatch");
    });
    const scheduled: Array<() => Promise<void>> = [];
    const firstNotify = vi.fn(consumeNotice);
    const pending = rejection("alice", "01JZ0000000000000000000115");
    const first = new ReefReceiptNotifier(firstNotify, notices.store, {
      now: () => 10_000,
      schedule: (task) => scheduled.push(task),
    });

    await first.notifyRejections([pending]);
    expect(firstNotify.mock.calls[0]![0]).toMatchObject({ allowResend: true });
    expect(notices.records.get(`${pending.peer}:${pending.id}`)?.phase).toBe("reserved");

    complete.mockRestore();
    const restartedNotify = vi.fn(consumeNotice);
    const restarted = new ReefReceiptNotifier(restartedNotify, notices.store, {
      now: () => 11_000,
    });
    const reservedNotice = notices.store.loadState(pending.peer);
    expect(reservedNotice).toBeDefined();
    await restarted.notifyRejections([{ ...pending, reservedNotice: reservedNotice! }]);

    expect(restartedNotify.mock.calls[0]![0]).toMatchObject({ allowResend: false });
    expect(notices.records.get(`${pending.peer}:${pending.id}`)?.phase).toBe("consumed");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_DM_RECOVERY_PROGRESS_TEXT,
  startCurrentDmRecoveryCoordinator,
  type CurrentDmRecoveryIdentity,
  type CurrentDmRecoveryPersistedState,
  type CurrentDmRecoveryScheduler,
  type CurrentDmRecoveryStore,
} from "./current-dm-recovery-coordinator.js";

const identity = (
  overrides: Partial<CurrentDmRecoveryIdentity> = {},
): CurrentDmRecoveryIdentity => ({
  agentId: "main",
  provider: "telegram",
  accountId: "default",
  chatId: "5397261498",
  senderId: "5397261498",
  inboundMessageId: 41,
  inboundUpdateId: 42,
  ingressGeneration: 3,
  featureGateGeneration: 7,
  sessionKey: "agent:main:telegram:direct:5397261498",
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
  ...overrides,
});

class FakeClock implements CurrentDmRecoveryScheduler {
  private current = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void | Promise<void> }>();

  now = () => this.current;

  scheduleAt = (at: number, callback: () => void | Promise<void>) => {
    const id = this.nextId++;
    this.timers.set(id, { at, callback });
    return id;
  };

  cancel = (handle: unknown) => {
    this.timers.delete(handle as number);
  };

  pendingTimes() {
    return [...this.timers.values()].map((timer) => timer.at).toSorted((a, b) => a - b);
  }

  async advanceTo(at: number) {
    this.current = at;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.current)
        .toSorted((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (due.length === 0) {
        return;
      }
      const [id, timer] = due[0];
      this.timers.delete(id);
      await timer.callback();
    }
  }
}

class FakeStore implements CurrentDmRecoveryStore {
  state?: CurrentDmRecoveryPersistedState;
  writes: CurrentDmRecoveryPersistedState[] = [];
  failNextSave = false;

  async load() {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async save(state: CurrentDmRecoveryPersistedState) {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("save failed");
    }
    this.state = structuredClone(state);
    this.writes.push(structuredClone(state));
  }
}

function harness(
  options: {
    enabled?: boolean;
    id?: CurrentDmRecoveryIdentity;
    store?: FakeStore;
    clock?: FakeClock;
    fresh?: () =>
      | { isCurrent: boolean; featureGateGeneration: number }
      | Promise<{ isCurrent: boolean; featureGateGeneration: number }>;
    send?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const store = options.store ?? new FakeStore();
  const clock = options.clock ?? new FakeClock();
  const send = options.send ?? vi.fn(async () => undefined);
  const fresh = options.fresh ?? (() => ({ isCurrent: true, featureGateGeneration: 7 }));
  return {
    store,
    clock,
    send,
    start: () =>
      startCurrentDmRecoveryCoordinator({
        enabled: options.enabled ?? true,
        identity: options.id ?? identity(),
        store,
        scheduler: clock,
        sendProgress: send,
        checkFreshness: fresh,
      }),
  };
}

describe("current DM recovery coordinator", () => {
  it("is disabled by default without touching dependencies", async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const send = vi.fn();
    const coordinator = await startCurrentDmRecoveryCoordinator({
      identity: identity(),
      store,
      scheduler: clock,
      sendProgress: send,
      checkFreshness: vi.fn(),
    });
    expect(coordinator).toBeUndefined();
    expect(store.writes).toHaveLength(0);
    expect(clock.pendingTimes()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: "other" },
    { provider: "signal" },
    { accountId: "other" },
    { chatId: "1" },
    { senderId: "1" },
    { threadId: "9" },
    { sessionKey: "agent:main:telegram:direct:other" },
    { sessionKey: "agent/main/telegram/direct/5397261498" },
    { sessionId: "" },
    { runId: "" },
    { turnId: "" },
    { inboundMessageId: 0 },
    { inboundUpdateId: 0 },
    { ingressGeneration: 0 },
    { featureGateGeneration: 0 },
  ])("rejects ineligible identity %# with zero effects", async (override) => {
    const h = harness({ id: identity(override as Partial<CurrentDmRecoveryIdentity>) });
    expect(await h.start()).toBeUndefined();
    expect(h.store.writes).toHaveLength(0);
    expect(h.clock.pendingTimes()).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("accepts only the exact identity and persists it before scheduling", async () => {
    const h = harness();
    const coordinator = await h.start();
    expect(coordinator).toBeDefined();
    expect(h.store.writes[0]?.identity).toEqual(identity());
    expect(h.clock.pendingTimes()).toEqual([120_000]);
  });

  it("emits status, checkpoint, and recovery milestones at 120/180/300 seconds", async () => {
    const h = harness();
    await h.start();
    await h.clock.advanceTo(120_000);
    await h.clock.advanceTo(180_000);
    await h.clock.advanceTo(300_000);
    expect(h.send.mock.calls.map(([message]) => message.milestone)).toEqual([
      "status",
      "checkpoint",
      "recovery",
    ]);
    expect(
      h.send.mock.calls.every(([message]) => message.text === CURRENT_DM_RECOVERY_PROGRESS_TEXT),
    ).toBe(true);
    expect(
      h.send.mock.calls.every(
        ([message]) => JSON.stringify(message.identity) === JSON.stringify(identity()),
      ),
    ).toBe(true);
  });

  it("resets deadlines on monotonic activity and invalidates stale callbacks", async () => {
    const h = harness();
    const coordinator = await h.start();
    await h.clock.advanceTo(100_000);
    await coordinator!.noteActivity(100_000);
    expect(h.clock.pendingTimes()).toEqual([220_000]);
    await h.clock.advanceTo(219_999);
    expect(h.send).not.toHaveBeenCalled();
    await h.clock.advanceTo(220_000);
    expect(h.send.mock.calls[0]?.[0].milestone).toBe("status");
    await coordinator!.noteActivity(90_000);
    expect(h.clock.pendingTimes()).toEqual([280_000]);
  });

  it("sends only the highest due unclaimed milestone after a delayed callback", async () => {
    const h = harness();
    await h.start();
    await h.clock.advanceTo(300_000);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]?.[0].milestone).toBe("recovery");
    expect(h.clock.pendingTimes()).toEqual([]);
  });

  it("tombstones stale identity and never sends", async () => {
    const h = harness({ fresh: () => ({ isCurrent: false, featureGateGeneration: 7 }) });
    await h.start();
    await h.clock.advanceTo(120_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.store.state?.lifecycle).toBe("stale");
    expect(h.clock.pendingTimes()).toEqual([]);
  });

  it("tombstones a changed feature-gate generation", async () => {
    const h = harness({ fresh: () => ({ isCurrent: true, featureGateGeneration: 8 }) });
    await h.start();
    await h.clock.advanceTo(120_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.store.state?.lifecycle).toBe("stale");
  });

  it("rechecks freshness after persisting intent and immediately before send", async () => {
    const fresh = vi
      .fn()
      .mockResolvedValueOnce({ isCurrent: true, featureGateGeneration: 7 })
      .mockResolvedValueOnce({ isCurrent: false, featureGateGeneration: 7 });
    const h = harness({ fresh });
    await h.start();
    await h.clock.advanceTo(120_000);
    expect(fresh).toHaveBeenCalledTimes(2);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.store.state?.lifecycle).toBe("stale");
  });

  it.each(["markFinalAccepted", "cancel", "markError"] as const)(
    "%s suppresses all future milestones",
    async (method) => {
      const h = harness();
      const coordinator = await h.start();
      await coordinator![method]();
      await h.clock.advanceTo(1_000_000);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.clock.pendingTimes()).toEqual([]);
    },
  );

  it("cancellation is idempotent", async () => {
    const h = harness();
    const coordinator = await h.start();
    await coordinator!.cancel();
    const writes = h.store.writes.length;
    await coordinator!.cancel();
    expect(h.store.writes).toHaveLength(writes);
  });

  it("persists intent before sending and does not send when intent persistence fails", async () => {
    const h = harness();
    await h.start();
    h.store.failNextSave = true;
    await h.clock.advanceTo(120_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.clock.pendingTimes()).toEqual([]);
  });

  it("records unknown after a sender throw and never retries", async () => {
    const send = vi.fn(async () => {
      throw new Error("ambiguous network result");
    });
    const h = harness({ send });
    await h.start();
    await h.clock.advanceTo(120_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.store.state?.milestones.status).toBe("unknown");
    await h.clock.advanceTo(1_000_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("adopts matching persisted active state without replaying claimed milestones", async () => {
    const store = new FakeStore();
    store.state = {
      version: 1,
      identity: identity(),
      lifecycle: "active",
      activityAt: 0,
      activityRevision: 1,
      milestones: { status: "sent", checkpoint: "unclaimed", recovery: "unclaimed" },
      updatedAt: 120_000,
    };
    const clock = new FakeClock();
    await clock.advanceTo(130_000);
    const h = harness({ store, clock });
    await h.start();
    expect(h.clock.pendingTimes()).toEqual([180_000]);
    await h.clock.advanceTo(180_000);
    expect(h.send.mock.calls.map(([message]) => message.milestone)).toEqual(["checkpoint"]);
  });
});

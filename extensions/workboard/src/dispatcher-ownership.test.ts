import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, PersistedWorkboardCard>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

describe("Workboard dispatcher ownership", () => {
  it("dispatches a card whose create input tried to inject archivedAt", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const now = 10;
    const card = await store.create({
      title: "Injected archive",
      status: "ready",
      workspaceAccess: { unrestricted: true },
      metadata: { archivedAt: now },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-injected" });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now, maxStarts: 1 },
    });

    expect(run).toHaveBeenCalledTimes(1);
    await expect(store.get(card.id)).resolves.toMatchObject({
      execution: { runId: "run-injected" },
    });
  });

  it("falls back to one default owner for persisted blank and unassigned agents", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);
    const blankAgent = await store.create({
      title: "Blank agent worker",
      status: "ready",
      priority: "urgent",
      workspaceAccess: { unrestricted: true },
    });
    await keyed.register(blankAgent.id, {
      version: 1,
      card: { ...blankAgent, agentId: "" },
    });
    const unassigned = await store.create({
      title: "Unassigned worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-default-owner" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: blankAgent.id, runId: "run-default-owner" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(blankAgent.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });
    await expect(store.get(unassigned.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("bounds failed worker attempts without draining the ready queue", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const cards = [];
    for (let index = 0; index < 5; index += 1) {
      cards.push(
        await store.create({
          title: `Queued worker ${index + 1}`,
          status: "ready",
          agentId: `worker-${index + 1}`,
          workspaceAccess: { unrestricted: true },
        }),
      );
    }
    const run = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.started).toEqual([]);
    expect(result.startFailures.map((failure) => failure.cardId)).toEqual([
      cards[0]?.id,
      cards[1]?.id,
    ]);
    await expect(Promise.all(cards.map((card) => store.get(card.id)))).resolves.toMatchObject([
      { status: "blocked" },
      { status: "blocked" },
      { status: "ready" },
      { status: "ready" },
      { status: "ready" },
    ]);
  });

  it("does not spend worker attempts on cards that fail workspace preflight", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const inaccessible = [];
    for (const [index, priority] of (["urgent", "high"] as const).entries()) {
      inaccessible.push(
        await store.create({
          title: `Inaccessible worker ${index + 1}`,
          status: "ready",
          priority,
          agentId: `inaccessible-worker-${index + 1}`,
          workspace: { kind: "worktree", path: "/repo" },
        }),
      );
    }
    const healthy = await store.create({
      title: "Healthy worker",
      status: "ready",
      agentId: "healthy-worker",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-healthy-worker" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.startFailures.map((failure) => failure.cardId)).toEqual(
      inaccessible.map((card) => card.id),
    );
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: healthy.id, runId: "run-healthy-worker" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    for (const card of inaccessible) {
      await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
    }
  });

  it("tries a healthy owner before retrying a failed owner's queued cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const failed = await store.create({
      title: "Failing urgent worker",
      status: "ready",
      priority: "urgent",
      agentId: "unavailable-worker",
      workspaceAccess: { unrestricted: true },
    });
    const deferred = await store.create({
      title: "Another unavailable worker card",
      status: "ready",
      priority: "high",
      agentId: "unavailable-worker",
      workspaceAccess: { unrestricted: true },
    });
    const healthy = await store.create({
      title: "Healthy independent worker",
      status: "ready",
      agentId: "healthy-worker",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ runId: "run-healthy-owner" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: healthy.id, runId: "run-healthy-owner" }),
    ]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({ cardId: failed.id, error: "provider unavailable" }),
    ]);
    await expect(store.get(failed.id)).resolves.toMatchObject({ status: "blocked" });
    await expect(store.get(deferred.id)).resolves.toMatchObject({ status: "ready" });
    await expect(store.get(healthy.id)).resolves.toMatchObject({ status: "running" });
  });

  it("preserves priority order among available owners when workers start successfully", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const urgent = await store.create({
      title: "Urgent primary worker",
      status: "ready",
      priority: "urgent",
      agentId: "primary-worker",
      workspaceAccess: { unrestricted: true },
    });
    const sameOwner = await store.create({
      title: "Second primary worker card",
      status: "ready",
      priority: "high",
      agentId: "primary-worker",
      workspaceAccess: { unrestricted: true },
    });
    const high = await store.create({
      title: "High-priority independent worker",
      status: "ready",
      priority: "high",
      agentId: "independent-worker",
      workspaceAccess: { unrestricted: true },
    });
    const normal = await store.create({
      title: "Normal-priority independent worker",
      status: "ready",
      agentId: "normal-worker",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-urgent" })
      .mockResolvedValueOnce({ runId: "run-high" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 2 },
    });

    expect(result.started.map((entry) => entry.cardId)).toEqual([urgent.id, high.id]);
    expect(run).toHaveBeenCalledTimes(2);
    await expect(store.get(sameOwner.id)).resolves.toMatchObject({ status: "ready" });
    await expect(store.get(normal.id)).resolves.toMatchObject({ status: "ready" });
  });

  it.each([
    { name: "matching", agentId: "shared-worker" },
    { name: "different", agentId: "assigned-worker" },
  ])(
    "keeps a cross-board running worker slot for a $name assigned agent until its heartbeat grace expires",
    async ({ agentId }) => {
      const store = new WorkboardStore(createMemoryStore());
      const stale = await store.create({
        title: "Abandoned product worker",
        status: "running",
        agentId,
        boardId: "product",
        execution: {
          id: "stale-execution",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          startedAt: 1,
          updatedAt: 1,
        },
      });
      const claimed = await store.claim(stale.id, {
        ownerId: "shared-worker",
        token: "stale-token",
        ttlSeconds: 1,
      });
      const ready = await store.create({
        title: "Ready operations recovery",
        status: "ready",
        agentId: "shared-worker",
        boardId: "ops",
        workspaceAccess: { unrestricted: true },
      });
      const run = vi.fn().mockResolvedValue({ runId: "run-after-grace" });
      const expiresAt = claimed.card.metadata?.claim?.expiresAt;
      expect(expiresAt).toBeDefined();

      const withinGrace = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: {
          now: expiresAt! + CLAIM_RECLAIM_MS,
          maxStarts: 1,
          boardId: "ops",
        },
      });

      expect(withinGrace.started).toEqual([]);
      expect(run).not.toHaveBeenCalled();
      await expect(store.get(stale.id)).resolves.toMatchObject({
        status: "running",
        execution: { status: "running" },
        metadata: { claim: { ownerId: "shared-worker" } },
      });

      const reclaimed = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: {
          now: expiresAt! + CLAIM_RECLAIM_MS + 1,
          maxStarts: 1,
          boardId: "ops",
        },
      });

      expect(reclaimed.started).toEqual([
        expect.objectContaining({ cardId: ready.id, runId: "run-after-grace" }),
      ]);
      expect(run).toHaveBeenCalledOnce();
      await expect(store.get(stale.id)).resolves.toMatchObject({
        status: "running",
        execution: { status: "running" },
        metadata: { claim: { ownerId: "shared-worker" } },
      });
    },
  );

  it("does not let an expired review claim consume worker capacity", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const now = Date.now();
    await store.create({
      title: "Expired review claim",
      status: "review",
      agentId: "shared-worker",
      metadata: {
        claim: {
          ownerId: "shared-worker",
          token: "expired-token",
          claimedAt: now - 60_000,
          lastHeartbeatAt: now - 60_000,
          expiresAt: now - 1_000,
        },
      },
    });
    const ready = await store.create({
      title: "Ready after expired review claim",
      status: "ready",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-after-expiry" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: ready.id, runId: "run-after-expiry" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    { wallClock: 10_000, dispatchNow: 50_000, expectedStarts: 1 },
    { wallClock: 50_000, dispatchNow: 10_000, expectedStarts: 0 },
  ])(
    "evaluates claim capacity at dispatch time instead of wall time ($wallClock, $dispatchNow)",
    async ({ wallClock, dispatchNow, expectedStarts }) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(wallClock);
        const store = new WorkboardStore(createMemoryStore());
        await store.create({
          title: "Review claim with a deterministic expiry",
          status: "review",
          agentId: "shared-worker",
          metadata: {
            claim: {
              ownerId: "shared-worker",
              token: "timed-token",
              claimedAt: 1_000,
              lastHeartbeatAt: 1_000,
              expiresAt: 20_000,
            },
          },
        });
        const ready = await store.create({
          title: "Worker using dispatch-time capacity",
          status: "ready",
          agentId: "shared-worker",
          workspaceAccess: { unrestricted: true },
        });
        const run = vi.fn().mockResolvedValue({ runId: "run-at-dispatch-time" });

        const result = await dispatchAndStartWorkboardCards({
          store,
          subagent: { run },
          options: { now: dispatchNow, maxStarts: 1 },
        });

        expect(run).toHaveBeenCalledTimes(expectedStarts);
        expect(result.started).toHaveLength(expectedStarts);
        if (expectedStarts === 1) {
          expect(result.started[0]).toMatchObject({
            cardId: ready.id,
            runId: "run-at-dispatch-time",
          });
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("replaces an expired ready-card claim without waiting for stale-claim cleanup", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const now = Date.now();
    const card = await store.create({
      title: "Ready with an expired lease",
      status: "ready",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
      metadata: {
        claim: {
          ownerId: "retired-worker",
          token: "expired-token",
          claimedAt: now - 60_000,
          lastHeartbeatAt: now - 60_000,
          expiresAt: now - 1_000,
        },
      },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-reclaimed" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: card.id, runId: "run-reclaimed" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "shared-worker" } },
    });
    expect((await store.get(card.id))?.metadata?.claim?.token).not.toBe("expired-token");
  });

  it("serializes concurrent board dispatches for the same worker", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ops = await store.create({
      title: "Ops shared worker",
      status: "ready",
      boardId: "ops",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const product = await store.create({
      title: "Product shared worker",
      status: "ready",
      boardId: "product",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const originalList = store.list.bind(store);
    let snapshotCount = 0;
    let releaseSnapshots: (() => void) | undefined;
    const snapshotsReleased = new Promise<void>((resolve) => {
      releaseSnapshots = resolve;
    });
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const cards = await originalList(options);
      if (options === undefined && snapshotCount < 2) {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          releaseTimer = setTimeout(() => releaseSnapshots?.(), 0);
        } else {
          if (releaseTimer !== undefined) {
            clearTimeout(releaseTimer);
          }
          releaseSnapshots?.();
        }
        await snapshotsReleased;
      }
      return cards;
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-shared-board" });

    const results = await Promise.all([
      dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { boardId: "ops", maxStarts: 1 },
      }),
      dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { boardId: "product", maxStarts: 1 },
      }),
    ]);

    expect(run).toHaveBeenCalledOnce();
    expect(results.flatMap((result) => result.started)).toEqual([
      expect.objectContaining({ cardId: ops.id, runId: "run-shared-board" }),
    ]);
    await expect(store.get(ops.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "shared-worker" } },
    });
    await expect(store.get(product.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps one worker slot across 25 concurrent board dispatches", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const cards = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.create({
          title: `Concurrent worker ${index}`,
          status: "ready",
          boardId: `board-${index}`,
          agentId: "shared-worker",
          workspaceAccess: { unrestricted: true },
        }),
      ),
    );
    const run = vi.fn().mockResolvedValue({ runId: "run-concurrent" });

    const results = await Promise.all(
      cards.map((card) =>
        dispatchAndStartWorkboardCards({
          store,
          subagent: { run },
          options: { boardId: card.metadata?.automation?.boardId, maxStarts: 1 },
        }),
      ),
    );

    expect(run).toHaveBeenCalledOnce();
    expect(results.flatMap((result) => result.started)).toHaveLength(1);
    const persisted = await store.list();
    expect(persisted.filter((card) => card.status === "running")).toHaveLength(1);
    expect(persisted.filter((card) => card.status === "ready")).toHaveLength(24);
  });

  it("preserves an accepted worker claim when execution persistence fails", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Worker with unavailable execution persistence",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-awaiting-persistence" });
    vi.spyOn(store, "update").mockRejectedValueOnce(new Error("execution persistence unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(run).toHaveBeenCalledOnce();
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "execution persistence unavailable",
      }),
    ]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });
    await expect(
      store.heartbeat(card.id, { ownerId: "workboard-dispatcher" }),
    ).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });

    const retry = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(retry.started).toEqual([]);
    expect(retry.startFailures).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps an accepted worker running when its worker log cannot be recorded", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Worker with unavailable logging",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-without-log" });
    vi.spyOn(store, "addWorkerLog").mockRejectedValueOnce(new Error("logger unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    expect(run).toHaveBeenCalledOnce();
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: card.id, runId: "run-without-log" }),
    ]);
    expect(result.startFailures).toEqual([]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      runId: "run-without-log",
      execution: { status: "running", runId: "run-without-log" },
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });
  });

  it("releases the owner slot for a done card with a stale running execution", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);
    const done = await store.create({
      title: "Finished worker",
      status: "ready",
      agentId: "worker-1",
      workspaceAccess: { unrestricted: true },
    });
    // Simulate a worker run that finished (card done) but whose execution
    // record was never closed, e.g. the gateway restarted mid-run.
    await keyed.register(done.id, {
      version: 1,
      card: {
        ...done,
        status: "done",
        execution: {
          id: "exec-stale",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          startedAt: 1,
          updatedAt: 2,
        },
      },
    });
    const ready = await store.create({
      title: "Next worker",
      status: "ready",
      agentId: "worker-1",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-next-worker" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: ready.id, runId: "run-next-worker" }),
    ]);
    expect(result.startFailures).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
  });
});

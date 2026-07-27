import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

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
});

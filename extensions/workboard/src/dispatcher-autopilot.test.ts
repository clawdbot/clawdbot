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

describe("guarded Workboard dispatch", () => {
  it("starts only explicitly assigned cards when an assignee is required", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Unassigned first",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const assigned = await store.create({
      title: "Assigned second",
      status: "ready",
      agentId: "writer",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-assigned" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1, requireAssigned: true },
    });

    expect(result.started).toEqual([expect.objectContaining({ cardId: assigned.id })]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not exceed board concurrency", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Already running",
      status: "running",
      agentId: "writer",
      workspaceAccess: { unrestricted: true },
      execution: {
        id: "active-execution",
        kind: "agent-session",
        mode: "autonomous",
        status: "running",
        startedAt: 1,
        updatedAt: 1,
      },
    });
    const ready = await store.create({
      title: "Waits for capacity",
      status: "ready",
      agentId: "reviewer",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: {
        now: 10,
        cardId: ready.id,
        maxStarts: 1,
        maxConcurrent: 1,
        requireAssigned: true,
      },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not let review cards consume an agent running slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Waiting for operator review",
      status: "review",
      priority: "normal",
      agentId: "codex-main",
    });
    const ready = await store.create({
      title: "Next ready card",
      status: "ready",
      priority: "high",
      agentId: "codex-main",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-next" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({
        cardId: ready.id,
        runId: "run-next",
      }),
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("starts workers only for the selected board", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ops = await store.create({
      title: "Ops worker",
      status: "ready",
      priority: "urgent",
      boardId: "ops",
      workspaceAccess: { unrestricted: true },
    });
    const product = await store.create({
      title: "Product worker",
      status: "ready",
      priority: "urgent",
      boardId: "product",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-ops" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3, boardId: "ops" },
    });

    expect(result.started).toEqual([expect.objectContaining({ cardId: ops.id })]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: expect.stringMatching(`^subagent:workboard-ops-${ops.id}-attempt-\\d+-`),
      lane: `workboard:ops:${ops.id}`,
    });
    await expect(store.get(product.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { boardId: "product" } },
    });
  });

  it("keeps claimed review cards in the owner running slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const review = await store.create({
      title: "Claimed operator review",
      status: "review",
      priority: "normal",
      agentId: "codex-main",
    });
    await store.claim(review.id, { ownerId: "codex-main", token: "review-token" });
    await store.create({
      title: "Next ready card",
      status: "ready",
      priority: "high",
      agentId: "codex-main",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-next" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("counts the active claim owner when checking worker capacity", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const running = await store.create({
      title: "Already claimed worker",
      status: "running",
      agentId: "alpha",
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(running.id, { ownerId: "shared-worker", token: "shared-token" });
    const ready = await store.create({
      title: "Waiting for the shared owner",
      status: "ready",
      agentId: "beta",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3, ownerId: "shared-worker" },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(ready.id)).resolves.toMatchObject({ status: "ready" });
  });
});

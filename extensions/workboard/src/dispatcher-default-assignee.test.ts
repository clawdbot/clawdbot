// Regression coverage for #116358: dispatch must apply the board's
// `orchestration.defaultAssignee` to ownerless cards *before* the claim, persisting it
// as the card's `agentId` so it becomes the owner of record and scopes the worker
// session key - not just a transient dispatcher identity. Also proves the existing
// no-default and explicit-owner-override compatibility cases, and that owner-capacity
// accounting sees the resolved (default-assignee-aware) owner.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { PersistedWorkboardBoard, PersistedWorkboardCard } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore<T>() {
  const entries = new Map<string, T>();
  return {
    async register(key: string, value: T) {
      entries.set(key, value);
    },
    async lookup(key: string) {
      return entries.get(key);
    },
    async delete(key: string) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

describe("dispatchAndStartWorkboardCards - board defaultAssignee", () => {
  it("applies the board default assignee to an ownerless card, persists it, and scopes the session key", async () => {
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const store = new WorkboardStore(createMemoryStore<PersistedWorkboardCard>(), { boards });
    await store.upsertBoard({ id: "ops", orchestration: { defaultAssignee: "ops-bot" } });
    const card = await store.create({
      title: "Ownerless ops card",
      status: "ready",
      boardId: "ops",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-default-assignee" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: card.id, runId: "run-default-assignee" }),
    ]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      agentId: "ops-bot",
      status: "running",
      metadata: { claim: { ownerId: "ops-bot" } },
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: expect.stringMatching(/^agent:ops-bot:/),
    });
  });

  it("does not override an existing agentId with the board default", async () => {
    // Explicit-owner compatibility case: a card someone already assigned keeps its
    // own owner even when the board has a default.
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const store = new WorkboardStore(createMemoryStore<PersistedWorkboardCard>(), { boards });
    await store.upsertBoard({ id: "ops", orchestration: { defaultAssignee: "ops-bot" } });
    const card = await store.create({
      title: "Already owned card",
      status: "ready",
      boardId: "ops",
      agentId: "alice",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-explicit-owner" });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({ agentId: "alice" });
  });

  it("leaves cards on a board with no default assignee unaffected", async () => {
    // No-default compatibility case: unchanged behavior when the board sets no
    // orchestration default at all. The claim step already backfills agentId from
    // the resolved dispatch owner regardless of this PR (store-workflow.ts, existing
    // on main), so the invariant this PR must not disturb is that the *fallback*
    // dispatcher owner - not a board default - is what lands there.
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const store = new WorkboardStore(createMemoryStore<PersistedWorkboardCard>(), { boards });
    await store.upsertBoard({ id: "ops" });
    const card = await store.create({
      title: "No default board card",
      status: "ready",
      boardId: "ops",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-no-default" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: card.id, runId: "run-no-default" }),
    ]);
    await expect(store.get(card.id)).resolves.toMatchObject({ agentId: "workboard-dispatcher" });
  });

  it("counts the default-assignee-resolved owner when checking worker capacity", async () => {
    // Owner-capacity accounting: two ownerless cards on a board with a default
    // assignee must share that owner's single worker slot, exactly like two cards
    // sharing an explicit ownerId already do.
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const store = new WorkboardStore(createMemoryStore<PersistedWorkboardCard>(), { boards });
    await store.upsertBoard({ id: "ops", orchestration: { defaultAssignee: "ops-bot" } });
    const first = await store.create({
      title: "First ownerless ops card",
      status: "ready",
      priority: "urgent",
      boardId: "ops",
      workspaceAccess: { unrestricted: true },
    });
    await store.create({
      title: "Second ownerless ops card",
      status: "ready",
      boardId: "ops",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-capacity" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: first.id, runId: "run-capacity" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
  });
});

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

describe("Workboard dispatcher lifecycle races", () => {
  it.each([
    { name: "archived", archive: true },
    { name: "completed", status: "done" as const },
    { name: "blocked", status: "blocked" as const },
    { name: "under review", status: "review" as const },
    { name: "moved to another board", boardId: "product" },
  ])("does not start a card $name during dispatch preflight", async (transition) => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Concurrent dispatch transition",
      status: "ready",
      boardId: "ops",
      workspaceAccess: { unrestricted: true },
    });
    const originalClaim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async (id, input, options) => {
      if ("archive" in transition) {
        await store.archive(id, true);
      } else if ("boardId" in transition) {
        await store.update(id, { boardId: transition.boardId });
      } else {
        await store.update(id, { status: transition.status });
      }
      return await originalClaim(id, input, options);
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, boardId: "ops", workspaceAccess: { unrestricted: true } },
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: expect.stringMatching(/archived|authority/),
      }),
    ]);
    const current = await store.get(card.id);
    expect(current?.metadata?.claim).toBeUndefined();
    if ("archive" in transition) {
      expect(current?.metadata?.archivedAt).toBeGreaterThan(0);
    } else if ("boardId" in transition) {
      expect(current?.metadata?.automation?.boardId).toBe("product");
    } else {
      expect(current?.status).toBe(transition.status);
    }
  });
});

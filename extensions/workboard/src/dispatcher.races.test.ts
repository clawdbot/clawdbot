import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("does not spend worker attempts on cards that change before they can be claimed", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const first = await store.create({
      title: "First stale dispatch",
      status: "ready",
      priority: "urgent",
      agentId: "first-worker",
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Second stale dispatch",
      status: "ready",
      priority: "high",
      agentId: "second-worker",
      workspaceAccess: { unrestricted: true },
    });
    const healthy = await store.create({
      title: "Healthy dispatch",
      status: "ready",
      priority: "normal",
      agentId: "healthy-worker",
      workspaceAccess: { unrestricted: true },
    });
    const originalClaim = store.claim.bind(store);
    const staleCardIds = new Set([first.id, second.id]);
    vi.spyOn(store, "claim").mockImplementation(async (id, input, options) => {
      if (staleCardIds.delete(id)) {
        await store.archive(id, true);
      }
      return await originalClaim(id, input, options);
    });
    const run = vi.fn().mockResolvedValue({ runId: "healthy-run" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
    });

    expect(result.startFailures.map((failure) => failure.cardId)).toEqual([first.id, second.id]);
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: healthy.id, runId: "healthy-run" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(healthy.id)).resolves.toMatchObject({ status: "running" });
    for (const cardId of [first.id, second.id]) {
      const archived = await store.get(cardId);
      expect(archived?.metadata?.archivedAt).toBeGreaterThan(0);
      expect(archived?.metadata?.claim).toBeUndefined();
    }
  });

  it("retains a managed worktree when pre-start lossless cleanup declines", async () => {
    const managedPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-retained-"));
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Retain failed worker checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
      workspaceAccess: { unrestricted: true },
    });
    const removeIfLossless = vi.fn().mockResolvedValue(false);
    try {
      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn().mockRejectedValue(new Error("model unavailable")) },
        worktrees: {
          resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
          create: vi.fn().mockResolvedValue({
            id: "managed-id",
            path: managedPath,
            branch: `openclaw/wb-${card.id}`,
          }),
          release: vi.fn(),
          removeIfLossless,
        },
        options: { now: 10, maxStarts: 1, materializeWorktree: true },
      });

      expect(result.startFailures).toEqual([
        expect.objectContaining({ cardId: card.id, error: "model unavailable" }),
      ]);
      expect(removeIfLossless).toHaveBeenCalledOnce();
      const blocked = await store.get(card.id);
      expect(blocked).toMatchObject({
        status: "blocked",
        metadata: {
          automation: {
            workspace: { kind: "worktree", path: managedPath, sourcePath: "/repo" },
          },
        },
      });
      expect(blocked?.execution).toBeUndefined();
      expect(blocked?.runId).toBeUndefined();
    } finally {
      fs.rmSync(managedPath, { recursive: true, force: true });
    }
  });
});

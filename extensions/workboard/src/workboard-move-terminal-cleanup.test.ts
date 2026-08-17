// workboard-move-terminal-cleanup.test.ts
// Regression test for issue #119592: `workboard_move` to a TERMINAL status
// (done / blocked / review) must clear the card's claim, close running
// attempts, and terminate a live execution — the same side-effect cleanup
// that `complete()` and `block()` apply — instead of leaving the card
// `status:"done"` with `metadata.claim` still set, `execution.status ===
// "running"`, and an open running attempt.
//
// The bug: `move()` (store-promote.ts) called `updateCard({status, position})`
// with no cleanup. A claimed, dispatched card moved to "done" kept its claim
// (the real worker could no longer complete it — assertCanMutateClaimedCard
// fails), kept `execution.status === "running"` (the owner's dispatch slot
// stayed consumed, blocking all other ready cards of the same owner), and kept
// an open running attempt, so the card was an active dependency target
// forever.
//
// The fix mirrors `complete`/`block`: when the target status is terminal,
// clear the claim, close running attempts, and mark a live execution terminal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
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

describe("move to a terminal status cleans up claim, execution, and running attempts", () => {
  it("moving a dispatched card to done clears claim, terminates execution, and closes attempts", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Dispatched card force-moved to done",
      status: "ready",
      agentId: "owner-a",
      workspaceAccess: { unrestricted: true },
    });

    // Dispatch the card so it has a live claim + running execution + attempt.
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-move-done" }) },
      options: { now: 10, maxStarts: 1 },
    });

    const afterDispatch = await store.get(card.id);
    expect(afterDispatch).toMatchObject({
      status: "running",
      execution: { status: "running", runId: "run-move-done" },
      metadata: { claim: expect.objectContaining({ ownerId: "owner-a" }) },
    });
    expect((afterDispatch?.metadata?.attempts ?? []).some((a) => a.status === "running")).toBe(
      true,
    );

    // The worker force-moves the card to a terminal status via workboard_move.
    const moved = await store.move(card.id, "done", undefined, { ownerId: "owner-a" });

    expect(moved.status).toBe("done");
    // The claim must be cleared so the card is no longer wedged.
    expect(moved.metadata?.claim).toBeUndefined();
    // The execution must not still be "running" — the owner's dispatch slot
    // would otherwise stay consumed forever.
    expect(moved.execution?.status).not.toBe("running");
    // No running attempt may remain open.
    expect(moved.metadata?.attempts ?? []).not.toContainEqual(
      expect.objectContaining({ status: "running" }),
    );
  });

  it("moving to a non-terminal status does NOT clear claim or execution (move is not complete)", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Dispatched card moved back to backlog",
      status: "ready",
      agentId: "owner-b",
      workspaceAccess: { unrestricted: true },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-move-backlog" }) },
      options: { now: 10, maxStarts: 1 },
    });

    const afterDispatch = await store.get(card.id);
    expect(afterDispatch).toMatchObject({
      status: "running",
      execution: { status: "running", runId: "run-move-backlog" },
      metadata: { claim: expect.objectContaining({ ownerId: "owner-b" }) },
    });

    // Non-terminal move: the card is NOT complete, so claim + execution must
    // survive untouched. Only terminal statuses apply the cleanup.
    const moved = await store.move(card.id, "backlog", undefined, { ownerId: "owner-b" });

    expect(moved.status).toBe("backlog");
    expect(moved.metadata?.claim).toMatchObject({ ownerId: "owner-b" });
    expect(moved.execution?.status).toBe("running");
    expect((moved.metadata?.attempts ?? []).some((a) => a.status === "running")).toBe(true);
  });

  it("moving a dispatched card to blocked clears claim and closes attempts", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Dispatched card force-moved to blocked",
      status: "ready",
      agentId: "owner-c",
      workspaceAccess: { unrestricted: true },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-move-blocked" }) },
      options: { now: 10, maxStarts: 1 },
    });

    const moved = await store.move(card.id, "blocked", undefined, { ownerId: "owner-c" });

    expect(moved.status).toBe("blocked");
    expect(moved.metadata?.claim).toBeUndefined();
    expect(moved.execution?.status).toBe("blocked");
    expect(moved.metadata?.attempts ?? []).not.toContainEqual(
      expect.objectContaining({ status: "running" }),
    );
  });

  it("moving a dispatched card to review clears claim and closes attempts", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Dispatched card force-moved to review",
      status: "ready",
      agentId: "owner-d",
      workspaceAccess: { unrestricted: true },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-move-review" }) },
      options: { now: 10, maxStarts: 1 },
    });

    const moved = await store.move(card.id, "review", undefined, { ownerId: "owner-d" });

    expect(moved.status).toBe("review");
    expect(moved.metadata?.claim).toBeUndefined();
    // The execution model has a "review" status; the run is over and awaiting
    // human review, so it must not stay "running".
    expect(moved.execution?.status).toBe("review");
    expect(moved.metadata?.attempts ?? []).not.toContainEqual(
      expect.objectContaining({ status: "running" }),
    );
  });

  it("persists the terminal cleanup through a real sqlite-backed store and frees the dispatch slot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-terminal-proof-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    try {
      const stores = createWorkboardSqliteStores({ dbPath });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });

      const holder = await store.create({
        title: "Slot holder force-moved to done",
        status: "ready",
        agentId: "owner-sqlite",
        workspaceAccess: { unrestricted: true },
      });
      const sibling = await store.create({
        title: "Sibling of same owner",
        status: "ready",
        agentId: "owner-sqlite",
        workspaceAccess: { unrestricted: true },
      });

      // Holder consumes owner-sqlite's single dispatch slot.
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn().mockResolvedValue({ runId: "run-sqlite-holder" }) },
        options: { now: 10, maxStarts: 2 },
      });
      expect(await store.get(holder.id)).toMatchObject({
        status: "running",
        execution: { status: "running" },
      });
      expect((await store.get(sibling.id))?.execution).toBeUndefined();

      // Move holder to a terminal status: claim + running execution must be
      // cleaned up and persisted, freeing the owner's dispatch slot.
      const moved = await store.move(holder.id, "done", undefined, {
        ownerId: "owner-sqlite",
      });
      expect(moved.status).toBe("done");
      expect(moved.metadata?.claim).toBeUndefined();
      expect(moved.execution?.status).not.toBe("running");

      // Re-open the store from the same on-disk db to prove the cleanup is
      // durable (not just in-memory state).
      stores.close();
      const reopenedStores = createWorkboardSqliteStores({ dbPath });
      try {
        const reopened = new WorkboardStore(reopenedStores.cards, {
          boards: reopenedStores.boards,
          subscriptions: reopenedStores.subscriptions,
          attachments: reopenedStores.attachments,
        });
        const persisted = await reopened.get(holder.id);
        expect(persisted?.status).toBe("done");
        expect(persisted?.metadata?.claim).toBeUndefined();
        expect(persisted?.execution?.status).not.toBe("running");

        // With the phantom execution gone on disk, the sibling can finally start.
        await dispatchAndStartWorkboardCards({
          store: reopened,
          subagent: { run: vi.fn().mockResolvedValue({ runId: "run-sqlite-sibling" }) },
          options: { now: 20, maxStarts: 2 },
        });
        expect(await reopened.get(sibling.id)).toMatchObject({
          status: "running",
          execution: { status: "running" },
        });
      } finally {
        reopenedStores.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

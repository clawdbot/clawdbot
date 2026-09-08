// release-claim-execution.test.ts
// Regression test for the Workboard `releaseClaim` phantom-execution wedge.
//
// The bug: when a card has actually been dispatched (execution.status ===
// "running", a runId, and a running attempt) and a worker hands it back via
// `workboard_release { status: "todo" }`, releaseClaim used to clear only
// `status` and `metadata.claim`. It never touched `execution` or running
// attempts, leaving the card `status:"todo"` with `claim: undefined` but STILL
// `execution.status === "running"` plus an open running attempt. Because
// `consumesOwnerSlot` treats any `execution.status === "running"` card as
// occupying the owner's dispatch slot, that phantom execution permanently
// wedges the owner's slot (the card can't be re-dispatched and blocks all other
// ready cards of the same owner).
//
// The fix mirrors `reclaim`: when the release moves the card out of running,
// clear the phantom execution, close running attempts, and drop stale.

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

describe("releaseClaim clears a phantom running execution", () => {
  it("releasing a dispatched card to a non-running status clears execution and running attempts", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Dispatched worker handed back to todo",
      status: "ready",
      agentId: "owner-a",
      workspaceAccess: { unrestricted: true },
    });

    // Dispatch the card so it has a live, running execution + claim.
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-release" }) },
      options: { now: 10, maxStarts: 1 },
    });

    const afterDispatch = await store.get(card.id);
    expect(afterDispatch).toMatchObject({
      status: "running",
      execution: { status: "running", runId: "run-release" },
      metadata: { claim: expect.objectContaining({ ownerId: "owner-a" }) },
    });

    // A worker hands the (dispatched) card back without completing it.
    const released = await store.releaseClaim(card.id, {
      ownerId: "owner-a",
      status: "todo",
    });

    expect(released.status).toBe("todo");
    expect(released.metadata?.claim).toBeUndefined();

    // The phantom execution must be gone — it must not still be "running",
    // otherwise the owner's dispatch slot stays wedged forever.
    expect(released.execution).toBeUndefined();

    // No running attempt may remain open.
    expect(released.metadata?.attempts ?? []).not.toContainEqual(
      expect.objectContaining({ status: "running" }),
    );
  });

  it("keeps execution when the release keeps the card running (pause case)", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Paused worker stays running",
      status: "ready",
      agentId: "owner-b",
      workspaceAccess: { unrestricted: true },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-pause" }) },
      options: { now: 10, maxStarts: 1 },
    });

    // Release WITHOUT a status change (pause): the card stays running, so the
    // live execution must be preserved (not nulled out).
    const released = await store.releaseClaim(card.id, { ownerId: "owner-b" });

    expect(released.status).toBe("running");
    expect(released.metadata?.claim).toBeUndefined();
    expect(released.execution?.status).toBe("running");
  });

  it("frees the owner's dispatch slot when a dispatched card is released", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card1 = await store.create({
      title: "Slot holder",
      status: "ready",
      agentId: "owner-a",
      workspaceAccess: { unrestricted: true },
    });
    const card2 = await store.create({
      title: "Blocked sibling",
      status: "ready",
      agentId: "owner-a",
      workspaceAccess: { unrestricted: true },
    });

    // First pass: owner-a's single dispatch slot is consumed by card1, so
    // card2 (same owner) must NOT start.
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-slot-holder" }) },
      options: { now: 10, maxStarts: 2 },
    });
    expect(await store.get(card1.id)).toMatchObject({
      status: "running",
      execution: { status: "running" },
    });
    expect((await store.get(card2.id))?.execution).toBeUndefined();

    // The worker hands card1 back without completing it.
    await store.releaseClaim(card1.id, { ownerId: "owner-a", status: "todo" });

    // Second pass: with the phantom execution gone, the owner slot is free
    // and card2 must finally start. Before the fix, card1's phantom
    // execution kept consuming the slot and card2 never started.
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-slot-freed" }) },
      options: { now: 20, maxStarts: 2 },
    });
    expect(await store.get(card2.id)).toMatchObject({
      status: "running",
      execution: { status: "running" },
    });
  });

  it("persists the release cleanup through a real sqlite-backed store and frees the dispatch slot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-release-proof-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    try {
      const stores = createWorkboardSqliteStores({ dbPath });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });

      const holder = await store.create({
        title: "Dispatched holder released to todo",
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

      // Worker hands the dispatched card back to a non-running status.
      await store.releaseClaim(holder.id, {
        ownerId: "owner-sqlite",
        status: "todo",
      });

      // The phantom execution must be gone and persisted, freeing the owner slot.
      stores.close();
      const reopenedStores = createWorkboardSqliteStores({ dbPath });
      try {
        const reopened = new WorkboardStore(reopenedStores.cards, {
          boards: reopenedStores.boards,
          subscriptions: reopenedStores.subscriptions,
          attachments: reopenedStores.attachments,
        });
        const persisted = await reopened.get(holder.id);
        expect(persisted?.status).toBe("todo");
        expect(persisted?.metadata?.claim).toBeUndefined();
        expect(persisted?.execution).toBeUndefined();
        expect(persisted?.metadata?.attempts ?? []).not.toContainEqual(
          expect.objectContaining({ status: "running" }),
        );

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

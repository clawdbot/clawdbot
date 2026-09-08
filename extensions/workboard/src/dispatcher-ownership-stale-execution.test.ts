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

describe("Workboard dispatcher stale execution recovery", () => {
  // Regression for #122911: a terminal status transition that left a running
  // execution record unclosed used to consume the owner's dispatch slot
  // forever, silently skipping every later ready card for that owner. The
  // state writer now finalizes the execution; the dispatcher guard below also
  // releases the slot for legacy stale rows the writer cannot reach.
  it.each([
    { label: "done via releaseClaim", releaseStatus: "done" as const },
    { label: "review via releaseClaim", releaseStatus: "review" as const },
    { label: "done via generic update", releaseStatus: undefined },
  ])(
    "finalizes a stale running execution on terminal transition and frees the owner slot ($label)",
    async ({ releaseStatus }) => {
      const keyed = createMemoryStore();
      const store = new WorkboardStore(keyed);
      const card = await store.create({
        title: "Stale worker",
        status: "ready",
        agentId: "worker-1",
        workspaceAccess: { unrestricted: true },
      });
      const claimed = await store.claim(card.id, { ownerId: "worker-1", token: "stale-tok" });
      // Simulate the dispatcher starting a worker run: card running + execution running.
      await keyed.register(card.id, {
        version: 1,
        card: {
          ...claimed.card,
          status: "running",
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
      // Move the card to a terminal-ish status without finalizing execution.
      if (releaseStatus === undefined) {
        await store.update(card.id, { status: "done" });
      } else {
        await store.releaseClaim(card.id, {
          ownerId: "worker-1",
          token: "stale-tok",
          status: releaseStatus,
        });
      }
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
        options: { now: 100, maxStarts: 1 },
      });

      expect(result.started).toEqual([
        expect.objectContaining({ cardId: ready.id, runId: "run-next-worker" }),
      ]);
      expect(result.startFailures).toEqual([]);
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("does not finalize execution when moving a non-running card with a stale running execution via a non-status patch", async () => {
    // The writer-side fix scopes to running -> non-running transitions. A card
    // already in a non-running status with a legacy stale execution is left
    // for the dispatcher guard; the writer must not rewrite execution on an
    // unrelated metadata patch.
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);
    const card = await store.create({
      title: "Legacy stale",
      status: "ready",
      agentId: "worker-1",
      workspaceAccess: { unrestricted: true },
    });
    await keyed.register(card.id, {
      version: 1,
      card: {
        ...card,
        execution: {
          id: "exec-legacy",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          startedAt: 1,
          updatedAt: 2,
        },
      },
    });
    const updated = await store.update(card.id, { title: "Legacy stale (renamed)" });
    expect(updated.execution?.status).toBe("running");
  });

  // Writer-side regression for #122911: terminal status transitions through
  // releaseClaim / generic update / move must finalize a still-running
  // execution so the card state and worker lifecycle stay consistent.
  // complete/block/reclaim pass an explicit execution and are covered by
  // existing store tests; these cover the paths that previously did not.
  it.each([
    { label: "releaseClaim -> done", via: "release-done" as const },
    { label: "releaseClaim -> review", via: "release-review" as const },
    { label: "generic update -> done", via: "update-done" as const },
    { label: "move -> done", via: "move-done" as const },
  ])("finalizes a running execution on terminal transition ($label)", async ({ via }) => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);
    const card = await store.create({
      title: "Running worker",
      status: "ready",
      agentId: "worker-1",
      workspaceAccess: { unrestricted: true },
    });
    const claimed = await store.claim(card.id, { ownerId: "worker-1", token: "fin-tok" });
    // Seed a prior failure so the reset semantics of done/review are observable:
    // a successful terminal transition must clear failureCount, not increment it.
    await keyed.register(card.id, {
      version: 1,
      card: {
        ...claimed.card,
        status: "running",
        execution: {
          id: "exec-fin",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          startedAt: 1,
          updatedAt: 2,
        },
        metadata: {
          ...claimed.card.metadata,
          failureCount: 1,
          attempts: [{ id: "exec-fin", status: "running", startedAt: 1, mode: "autonomous" }],
        },
      },
    });

    let result;
    if (via === "release-done") {
      result = await store.releaseClaim(card.id, {
        ownerId: "worker-1",
        token: "fin-tok",
        status: "done",
      });
    } else if (via === "release-review") {
      result = await store.releaseClaim(card.id, {
        ownerId: "worker-1",
        token: "fin-tok",
        status: "review",
      });
    } else if (via === "update-done") {
      result = await store.update(card.id, { status: "done" });
    } else {
      result = await store.move(card.id, "done", undefined, {
        ownerId: "worker-1",
        token: "fin-tok",
      });
    }

    const expectedExecutionStatus = via === "release-review" ? "review" : "done";
    expect(result.execution?.status).toBe(expectedExecutionStatus);
    // done/review are successful worker outcomes: the matching attempt succeeds
    // and failureCount resets (removeUndefinedMetadataFields drops a zero
    // failureCount), so a review handoff is not counted as a failure.
    expect(result.metadata?.attempts?.at(-1)?.status).toBe("succeeded");
    expect(result.metadata?.failureCount).toBeUndefined();
  });

  it("does not regress complete/block/reclaim explicit execution finalization", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);

    const completeCard = await store.create({
      title: "Complete path",
      status: "ready",
      agentId: "worker-2",
      workspaceAccess: { unrestricted: true },
    });
    const completeClaimed = await store.claim(completeCard.id, {
      ownerId: "worker-2",
      token: "c-tok",
    });
    await keyed.register(completeCard.id, {
      version: 1,
      card: {
        ...completeClaimed.card,
        status: "running",
        execution: {
          id: "exec-c",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          startedAt: 1,
          updatedAt: 2,
        },
      },
    });
    const completed = await store.complete(completeCard.id, {
      ownerId: "worker-2",
      token: "c-tok",
      summary: "Done.",
    });
    expect(completed.execution?.status).toBe("done");

    const blockCard = await store.create({
      title: "Block path",
      status: "ready",
      agentId: "worker-3",
      workspaceAccess: { unrestricted: true },
    });
    const blockClaimed = await store.claim(blockCard.id, { ownerId: "worker-3", token: "b-tok" });
    await keyed.register(blockCard.id, {
      version: 1,
      card: {
        ...blockClaimed.card,
        status: "running",
        execution: {
          id: "exec-b",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          startedAt: 1,
          updatedAt: 2,
        },
      },
    });
    const blocked = await store.block(blockCard.id, {
      ownerId: "worker-3",
      token: "b-tok",
      reason: "Stuck.",
    });
    expect(blocked.execution?.status).toBe("blocked");
  });

  // Direct persisted legacy fixture proof (requested by review): a card that
  // was already in a terminal status with a stale running execution before
  // this fix shipped must not block a later same-owner ready card. These rows
  // never pass through the writer's running->non-running branch, so the
  // dispatcher capacity guard is their only release path.
  it.each([
    { label: "done", legacyStatus: "done" as const },
    { label: "review", legacyStatus: "review" as const },
  ])(
    "does not count a persisted legacy $label card with stale running execution against owner capacity",
    async ({ legacyStatus }) => {
      const keyed = createMemoryStore();
      const store = new WorkboardStore(keyed);
      const legacy = await store.create({
        title: "Legacy stale terminal card",
        status: "ready",
        agentId: "worker-legacy",
        workspaceAccess: { unrestricted: true },
      });
      // Inject the legacy stale state directly: terminal card status + running execution.
      await keyed.register(legacy.id, {
        version: 1,
        card: {
          ...legacy,
          status: legacyStatus,
          execution: {
            id: "exec-legacy-stale",
            kind: "agent-session",
            mode: "autonomous",
            status: "running",
            startedAt: 1,
            updatedAt: 2,
          },
        },
      });
      const ready = await store.create({
        title: "Next worker after legacy stale",
        status: "ready",
        agentId: "worker-legacy",
        workspaceAccess: { unrestricted: true },
      });
      const run = vi.fn().mockResolvedValue({ runId: "run-after-legacy" });

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { now: 100, maxStarts: 1 },
      });

      expect(result.started).toEqual([
        expect.objectContaining({ cardId: ready.id, runId: "run-after-legacy" }),
      ]);
      expect(result.startFailures).toEqual([]);
      expect(run).toHaveBeenCalledOnce();
    },
  );

  // Production-boundary proof (requested by review): exercise the legacy
  // stale-execution recovery through a real SQLite-backed WorkboardStore,
  // not just an in-memory map. This proves the fix holds across the actual
  // persistence and read path a production gateway uses.
  it("does not count a persisted legacy done card with stale running execution against owner capacity (SQLite boundary)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-stale-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    try {
      const stores = createWorkboardSqliteStores({ dbPath });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const legacy = await store.create({
        title: "Legacy stale done (SQLite)",
        status: "ready",
        agentId: "worker-sqlite",
        workspaceAccess: { unrestricted: true },
      });
      // Inject the legacy stale state through the SQLite persistence layer.
      const existing = await stores.cards.lookup(legacy.id);
      expect(existing).toBeDefined();
      await stores.cards.register(legacy.id, {
        version: 1,
        card: {
          ...existing!.card,
          status: "done",
          execution: {
            id: "exec-sqlite-stale",
            kind: "agent-session",
            mode: "autonomous",
            status: "running",
            startedAt: 1,
            updatedAt: 2,
          },
        },
      });
      // Verify the stale state round-tripped through SQLite.
      const reloaded = await store.get(legacy.id);
      expect(reloaded?.status).toBe("done");
      expect(reloaded?.execution?.status).toBe("running");

      const ready = await store.create({
        title: "Next worker (SQLite)",
        status: "ready",
        agentId: "worker-sqlite",
        workspaceAccess: { unrestricted: true },
      });
      const run = vi.fn().mockResolvedValue({ runId: "run-sqlite-after-stale" });

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { now: 100, maxStarts: 1 },
      });

      expect(result.started).toEqual([
        expect.objectContaining({ cardId: ready.id, runId: "run-sqlite-after-stale" }),
      ]);
      expect(result.startFailures).toEqual([]);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ClawSweeper P1 re-review: lifecycle success (succeeded state) maps the
  // card to review and execution to review via syncLifecycle, but previously
  // did not clear card.metadata.claim. The changed workboardCardConsumesOwnerSlot
  // predicate still counted active claims for every non-done card — including
  // a lifecycle-completed review card — so the next card for that owner
  // remained blocked until claim expiry. The fix clears the claim at the
  // lifecycle owner (syncLifecycle) and excludes terminal review/blocked
  // claims from the capacity predicate as defense-in-depth (#122911).
  it("releases the dispatch claim on lifecycle success and frees the owner slot for follow-up dispatch", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);
    const card = await store.create({
      title: "Lifecycle worker",
      status: "ready",
      agentId: "worker-lifecycle",
      workspaceAccess: { unrestricted: true },
    });
    // Dispatch claims the card and starts a worker run.
    const claimed = await store.claim(card.id, { ownerId: "worker-lifecycle", token: "lc-tok" });
    const sessionKey = "subagent:workboard-lifecycle-test";
    // Seed running state with execution and session key.
    await keyed.register(card.id, {
      version: 1,
      card: {
        ...claimed.card,
        status: "running",
        sessionKey,
        runId: "run-lifecycle",
        execution: {
          id: "exec-lifecycle",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          sessionKey,
          runId: "run-lifecycle",
          startedAt: 1,
          updatedAt: 2,
        },
      },
    });
    // Verify the claim exists before lifecycle success.
    const beforeLifecycle = await store.get(card.id);
    expect(beforeLifecycle?.metadata?.claim).toBeDefined();

    // Lifecycle success: worker finished, card -> review, execution -> review.
    await store.syncLifecycle(card.id, {
      targetStatus: "review",
      executionStatus: "review",
      sourceUpdatedAt: beforeLifecycle!.updatedAt + 1,
      stale: undefined,
      now: beforeLifecycle!.updatedAt + 1,
    });

    const afterLifecycle = await store.get(card.id);
    expect(afterLifecycle?.status).toBe("review");
    expect(afterLifecycle?.execution?.status).toBe("review");
    // The dispatch claim must be released so it no longer holds the owner slot.
    expect(afterLifecycle?.metadata?.claim).toBeUndefined();

    // A follow-up ready card for the same owner must dispatch successfully.
    const ready = await store.create({
      title: "Next worker after lifecycle",
      status: "ready",
      agentId: "worker-lifecycle",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-after-lifecycle" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 100, maxStarts: 1 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: ready.id, runId: "run-after-lifecycle" }),
    ]);
    expect(result.startFailures).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
  });

  // Defense-in-depth: even if a legacy review/blocked card still has an
  // active claim (e.g. from before syncLifecycle cleared claims), the
  // capacity predicate must not count it against the owner's slot.
  it("does not count a legacy review card with an active claim against owner capacity", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);
    const legacy = await store.create({
      title: "Legacy review with claim",
      status: "ready",
      agentId: "worker-legacy-claim",
      workspaceAccess: { unrestricted: true },
    });
    // Inject a legacy review card with an active claim that was never cleared.
    await keyed.register(legacy.id, {
      version: 1,
      card: {
        ...legacy,
        status: "review",
        execution: {
          id: "exec-legacy-review",
          kind: "agent-session",
          mode: "autonomous",
          status: "review",
          startedAt: 1,
          updatedAt: 2,
        },
        metadata: {
          ...legacy.metadata,
          claim: {
            ownerId: "worker-legacy-claim",
            token: "legacy-tok",
            claimedAt: 1,
            expiresAt: 999999,
            lastHeartbeatAt: 50,
          },
        },
      },
    });
    const ready = await store.create({
      title: "Next worker after legacy review",
      status: "ready",
      agentId: "worker-legacy-claim",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-after-legacy-review" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 100, maxStarts: 1 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: ready.id, runId: "run-after-legacy-review" }),
    ]);
    expect(result.startFailures).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
  });

  // ClawSweeper P1 re-review: the original finalization condition fired for
  // every running-to-non-running transition, including non-terminal statuses
  // (backlog, triage, scheduled, ready, and the "todo" status). move()
  // preserves the active claim and routes through updateCard, so moving a
  // claimed running card aside used to mark its execution as blocked.
  // completeDirect only converts a still-running execution to done, so the
  // later successful completion retained blocked and the attempt synchronizer
  // recorded a failure. The fix restricts finalization to terminal statuses
  // (done/review/blocked).
  it("preserves running execution when a claimed running card is moved to a non-terminal status", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);
    const card = await store.create({
      title: "Move-aside worker",
      status: "ready",
      agentId: "worker-move-aside",
      workspaceAccess: { unrestricted: true },
    });
    const claimed = await store.claim(card.id, {
      ownerId: "worker-move-aside",
      token: "move-tok",
    });
    const sessionKey = "subagent:workboard-move-aside-test";
    await keyed.register(card.id, {
      version: 1,
      card: {
        ...claimed.card,
        status: "running",
        sessionKey,
        runId: "run-move-aside",
        execution: {
          id: "exec-move-aside",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          sessionKey,
          runId: "run-move-aside",
          startedAt: 1,
          updatedAt: 2,
        },
      },
    });

    // Move the claimed running card aside to a non-terminal status (todo).
    const moved = await store.move(card.id, "todo", undefined, {
      ownerId: "worker-move-aside",
      token: "move-tok",
    });
    expect(moved.status).toBe("todo");
    // The execution must stay running — todo is not a terminal worker outcome.
    expect(moved.execution?.status).toBe("running");
    // No failure must be recorded for a non-terminal move.
    expect(moved.metadata?.attempts?.at(-1)?.status).toBe("running");
    expect(moved.metadata?.failureCount).toBeUndefined();

    // A subsequent successful completion must finalize the execution as done.
    const completed = await store.complete(card.id, {
      ownerId: "worker-move-aside",
      token: "move-tok",
      summary: "Completed after move-aside.",
    });
    expect(completed.status).toBe("done");
    expect(completed.execution?.status).toBe("done");
    expect(completed.metadata?.attempts?.at(-1)?.status).toBe("succeeded");
    expect(completed.metadata?.failureCount).toBeUndefined();
  });

  // Production-boundary proof (ClawSweeper real-behavior gate): exercise the
  // move-aside-then-complete path through a real SQLite-backed WorkboardStore,
  // not just an in-memory map. This proves the terminal-only finalization fix
  // holds across the actual persistence and read path a production gateway
  // uses, and that a successful completion after a non-terminal move is
  // recorded as done (not blocked) in the persisted store.
  it("preserves running execution and records successful completion after a non-terminal move (SQLite boundary)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-move-aside-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    try {
      const stores = createWorkboardSqliteStores({ dbPath });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const card = await store.create({
        title: "Move-aside worker (SQLite)",
        status: "ready",
        agentId: "worker-sqlite-move-aside",
        workspaceAccess: { unrestricted: true },
      });
      await store.claim(card.id, {
        ownerId: "worker-sqlite-move-aside",
        token: "sqlite-move-tok",
      });
      const sessionKey = "subagent:workboard-sqlite-move-aside-test";
      // Inject running state through the SQLite persistence layer.
      const existing = await stores.cards.lookup(card.id);
      expect(existing).toBeDefined();
      await stores.cards.register(card.id, {
        version: 1,
        card: {
          ...existing!.card,
          status: "running",
          sessionKey,
          runId: "run-sqlite-move-aside",
          execution: {
            id: "exec-sqlite-move-aside",
            kind: "agent-session",
            mode: "autonomous",
            status: "running",
            sessionKey,
            runId: "run-sqlite-move-aside",
            startedAt: 1,
            updatedAt: 2,
          },
        },
      });
      // Verify the running state round-tripped through SQLite.
      const reloaded = await store.get(card.id);
      expect(reloaded?.status).toBe("running");
      expect(reloaded?.execution?.status).toBe("running");

      // Move the claimed running card aside to a non-terminal status (todo).
      const moved = await store.move(card.id, "todo", undefined, {
        ownerId: "worker-sqlite-move-aside",
        token: "sqlite-move-tok",
      });
      expect(moved.status).toBe("todo");
      expect(moved.execution?.status).toBe("running");
      expect(moved.metadata?.failureCount).toBeUndefined();

      // Verify the preserved execution round-tripped through SQLite.
      const movedReloaded = await store.get(card.id);
      expect(movedReloaded?.status).toBe("todo");
      expect(movedReloaded?.execution?.status).toBe("running");

      // A subsequent successful completion must finalize as done in SQLite.
      const completed = await store.complete(card.id, {
        ownerId: "worker-sqlite-move-aside",
        token: "sqlite-move-tok",
        summary: "Completed after SQLite move-aside.",
      });
      expect(completed.execution?.status).toBe("done");
      expect(completed.metadata?.attempts?.at(-1)?.status).toBe("succeeded");
      expect(completed.metadata?.failureCount).toBeUndefined();

      // Verify the finalized state round-tripped through SQLite.
      const completedReloaded = await store.get(card.id);
      expect(completedReloaded?.status).toBe("done");
      expect(completedReloaded?.execution?.status).toBe("done");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

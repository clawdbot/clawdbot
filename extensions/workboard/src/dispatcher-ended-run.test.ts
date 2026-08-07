// Workboard ended-run tests cover lifecycle reconciliation and stale-event races.
import { describe, expect, it, vi } from "vitest";
import { cleanupWorkboardRunWorktree, reconcileWorkboardEndedRun } from "./dispatcher-workspace.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
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
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

describe("reconcileWorkboardEndedRun", () => {
  it("blocks an ended run that did not complete or block its card", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Worker that exited without closeout",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-without-closeout" }) },
      options: { now: 10, maxStarts: 1 },
    });

    await reconcileWorkboardEndedRun({
      store,
      runId: "run-without-closeout",
      outcome: "ok",
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked", runId: "run-without-closeout" },
      metadata: {
        failureCount: 1,
        workerProtocol: { state: "violated" },
        attempts: [expect.objectContaining({ status: "blocked" })],
      },
    });
    expect((await store.get(card.id))?.metadata?.claim).toBeUndefined();

    await reconcileWorkboardEndedRun({
      store,
      runId: "run-without-closeout",
      outcome: "ok",
    });
    expect((await store.get(card.id))?.metadata?.failureCount).toBe(1);
  });

  it("ignores an ended event for a reclaimed run after a replacement claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Replacement claim task",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "retired-run" }) },
      options: { now: 10, maxStarts: 1 },
    });
    await store.reclaim(card.id, { reason: "replace retired worker" }, null);
    const replacement = await store.claim(card.id, { ownerId: "replacement-worker" });

    await reconcileWorkboardEndedRun({
      store,
      runId: "retired-run",
      outcome: "error",
    });

    const saved = await store.get(card.id);
    expect(saved).toMatchObject({
      status: "running",
      runId: "retired-run",
      metadata: { claim: { ownerId: "replacement-worker", token: replacement.token } },
    });
    expect(saved?.execution).toBeUndefined();
    expect(saved?.metadata?.workerProtocol).toBeUndefined();
    expect(saved?.metadata?.failureCount).toBeUndefined();
  });

  it("does not overwrite a card already completed by its ended run", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Worker with closeout",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-with-closeout" }) },
      options: { now: 10, maxStarts: 1 },
    });
    await store.complete(card.id, { summary: "verified" }, null);

    await reconcileWorkboardEndedRun({
      store,
      runId: "run-with-closeout",
      outcome: "ok",
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "done",
      execution: { status: "done", runId: "run-with-closeout" },
    });
    const completed = await store.get(card.id);
    expect(completed?.metadata?.failureCount).toBeUndefined();
    expect(completed?.metadata?.workerProtocol).toBeUndefined();
  });

  it("does not clean a replacement worktree for a stale ended run", async () => {
    const store = new WorkboardStore(createMemoryStore());
    let acceptReplacement: ((value: { runId: string }) => void) | undefined;
    const replacementRun = new Promise<{ runId: string }>((resolve) => {
      acceptReplacement = resolve;
    });
    let replacementStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-a" })
      .mockImplementationOnce(() => {
        replacementStarted?.();
        return replacementRun;
      });
    const removeIfLossless = vi.fn().mockResolvedValue(true);
    const worktrees = {
      resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
      create: vi
        .fn()
        .mockResolvedValueOnce({
          id: "worktree-a",
          path: "/state/worktrees/card/run-a",
          branch: "openclaw/wb-run-a",
        })
        .mockResolvedValueOnce({
          id: "worktree-b",
          path: "/state/worktrees/card/run-b",
          branch: "openclaw/wb-run-b",
        }),
      release: vi.fn(),
      removeIfLossless,
    };
    const card = await store.create({
      title: "Replacement worktree task",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
      workspaceAccess: { unrestricted: true },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: { now: 10, maxStarts: 1, materializeWorktree: true },
    });
    await cleanupWorkboardRunWorktree({ store, worktrees, runId: "run-a" });
    expect(removeIfLossless).toHaveBeenCalledWith({
      path: "/state/worktrees/card/run-a",
      ownerKind: "workboard",
      ownerId: card.id,
    });
    removeIfLossless.mockClear();
    await store.reclaim(card.id, { reason: "replace retired worker" }, null);

    const replacementDispatch = dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: { now: 20, maxStarts: 1, materializeWorktree: true },
    });
    await started;
    await expect(store.get(card.id)).resolves.toMatchObject({
      runId: "run-a",
      metadata: {
        claim: expect.any(Object),
        automation: { workspace: { path: "/state/worktrees/card/run-b" } },
      },
    });

    await reconcileWorkboardEndedRun({ store, runId: "run-a", outcome: "error" });
    await cleanupWorkboardRunWorktree({ store, worktrees, runId: "run-a" });

    expect(removeIfLossless).not.toHaveBeenCalled();
    acceptReplacement?.({ runId: "run-b" });
    await replacementDispatch;
  });

  it("serializes worktree cleanup against a replacement claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    let releaseRemoval: (() => void) | undefined;
    const removalRelease = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let markRemovalStarted: (() => void) | undefined;
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve;
    });
    const removeIfLossless = vi.fn().mockImplementation(async () => {
      markRemovalStarted?.();
      await removalRelease;
      return true;
    });
    const worktrees = {
      resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
      create: vi
        .fn()
        .mockResolvedValueOnce({
          id: "worktree-a",
          path: "/state/worktrees/card/run-a",
          branch: "openclaw/wb-run-a",
        })
        .mockResolvedValueOnce({
          id: "worktree-b",
          path: "/state/worktrees/card/run-b",
          branch: "openclaw/wb-run-b",
        }),
      release: vi.fn(),
      removeIfLossless,
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-a" })
      .mockResolvedValueOnce({ runId: "run-b" });
    const card = await store.create({
      title: "Serialized worktree task",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
      workspaceAccess: { unrestricted: true },
    });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: { now: 10, maxStarts: 1, materializeWorktree: true },
    });
    await store.reclaim(card.id, { reason: "replace retired worker" }, null);

    const cleanup = cleanupWorkboardRunWorktree({ store, worktrees, runId: "run-a" });
    await removalStarted;
    const originalClaim = store.claim.bind(store);
    let markClaimSettled: (() => void) | undefined;
    const claimSettled = new Promise<void>((resolve) => {
      markClaimSettled = resolve;
    });
    vi.spyOn(store, "claim").mockImplementation(async (...args) => {
      const claimed = await originalClaim(...args);
      markClaimSettled?.();
      return claimed;
    });
    const replacementDispatch = dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: { now: 20, maxStarts: 1, materializeWorktree: true },
    });
    const claimEscapedCleanup = await Promise.race([
      claimSettled.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 50);
      }),
    ]);
    releaseRemoval?.();
    await Promise.all([cleanup, replacementDispatch]);

    expect(claimEscapedCleanup).toBe(false);
    expect(worktrees.create).toHaveBeenCalledTimes(2);
  });

  it("serializes a stale ended-run snapshot against a replacement run", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const run = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-a" })
      .mockResolvedValueOnce({ runId: "run-b" });
    const card = await store.create({
      title: "Replay-safe task",
      status: "ready",
      metadata: { automation: { enabled: true } },
    });

    await dispatchAndStartWorkboardCards({ store, subagent: { run } });

    let snapshotCaptured: (() => void) | undefined;
    const captured = new Promise<void>((resolve) => {
      snapshotCaptured = resolve;
    });
    let releaseSnapshot: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const originalList = store.list.bind(store);
    vi.spyOn(store, "list").mockImplementationOnce(async () => {
      const snapshot = await originalList();
      snapshotCaptured?.();
      await release;
      return snapshot;
    });

    const lateEnded = reconcileWorkboardEndedRun({ store, runId: "run-a", outcome: "error" });
    await captured;
    const reclaimed = store.reclaim(
      card.id,
      { reason: "retry with a fresh worker", status: "ready" },
      null,
    );
    releaseSnapshot?.();
    await Promise.all([lateEnded, reclaimed]);
    await dispatchAndStartWorkboardCards({ store, subagent: { run } });

    const after = await store.get(card.id);
    expect(run).toHaveBeenCalledTimes(2);
    expect(after).toMatchObject({
      status: "running",
      runId: "run-b",
      execution: { status: "running", runId: "run-b" },
    });
    expect(after?.metadata?.claim).toBeDefined();
  });
});

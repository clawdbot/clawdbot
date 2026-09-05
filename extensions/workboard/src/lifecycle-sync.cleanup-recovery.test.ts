import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkboardExecution } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardLifecycleService, syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

const SESSION_KEY = "agent:main:subagent:workboard-cleanup-recovery";
const RUN_ID = "run-cleanup-recovery";
const MANAGED_PATH = "/state/worktrees/recovery/wb-card";
const SOURCE_PATH = "/repo";

function openStore(dbPath: string) {
  const stores = createWorkboardSqliteStores({ dbPath });
  return { store: new WorkboardStore(stores.cards), stores };
}

function execution(
  sessionKey: string,
  runId: string,
  status: WorkboardExecution["status"],
): WorkboardExecution {
  return {
    id: `exec-${runId}`,
    kind: "agent-session",
    mode: "autonomous",
    status,
    sessionKey,
    runId,
    startedAt: 1000,
    updatedAt: 1000,
  };
}

async function createManagedCard(
  store: WorkboardStore,
  options: {
    managedPath?: string;
    status?: "blocked" | "running" | "review";
    withExecutionAssociation?: boolean;
  } = {},
) {
  const status = options.status ?? "running";
  const withExecutionAssociation = options.withExecutionAssociation !== false;
  return await store.create({
    title: "Recover managed worktree cleanup",
    status,
    ...(withExecutionAssociation
      ? {
          sessionKey: SESSION_KEY,
          runId: RUN_ID,
          execution: execution(SESSION_KEY, RUN_ID, status),
        }
      : {}),
    workspace: {
      kind: "worktree",
      path: options.managedPath ?? MANAGED_PATH,
      branch: "openclaw/wb-card",
      sourcePath: SOURCE_PATH,
      sourceBranch: "main",
    },
  });
}

function doneSessionSnapshot(updatedAt: number) {
  return vi.fn().mockResolvedValue({
    sessions: [
      {
        key: SESSION_KEY,
        status: "done" as const,
        hasActiveRun: false,
        updatedAt,
      },
    ],
    complete: true,
  });
}

const context = { logger: { warn: vi.fn() } } as never;

describe("Workboard managed-worktree cleanup recovery", () => {
  it("retries cleanup after a hook failure and process restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-cleanup-recovery-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const initial = openStore(dbPath);
    const card = await createManagedCard(initial.store);
    const removeIfLossless = vi
      .fn()
      .mockRejectedValueOnce(new Error("worktree registry unavailable"))
      .mockResolvedValueOnce(true);
    const worktrees = { removeIfLossless };

    await expect(
      syncWorkboardSubagentEnded({
        store: initial.store,
        worktrees,
        event: {
          targetSessionKey: SESSION_KEY,
          runId: RUN_ID,
          endedAt: card.updatedAt + 1,
          outcome: "ok",
        },
      }),
    ).rejects.toThrow("worktree registry unavailable");
    initial.stores.close();

    const restarted = openStore(dbPath);
    const service = createWorkboardLifecycleService({
      store: restarted.store,
      readSessions: doneSessionSnapshot(card.updatedAt + 1),
      worktrees,
    });

    try {
      await service.start(context);
      service.onGatewayStart();
      await vi.waitFor(() => expect(removeIfLossless).toHaveBeenCalledTimes(2));

      expect(removeIfLossless).toHaveBeenLastCalledWith({
        path: MANAGED_PATH,
        ownerKind: "workboard",
        ownerId: card.id,
      });
      const recovered = await restarted.store.get(card.id);
      expect(recovered).toMatchObject({ status: "review", execution: { status: "review" } });
      expect(recovered?.metadata?.automation?.workspace).toEqual({
        kind: "worktree",
        path: SOURCE_PATH,
        branch: "main",
      });
    } finally {
      service.onGatewayStop();
      await service.stop?.(context);
      restarted.stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans a freshly reconciled terminal worktree in the initial restart sweep", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-cleanup-fresh-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const initial = openStore(dbPath);
    const card = await createManagedCard(initial.store);
    initial.stores.close();

    const restarted = openStore(dbPath);
    const removeIfLossless = vi.fn().mockResolvedValue(true);
    const service = createWorkboardLifecycleService({
      store: restarted.store,
      readSessions: doneSessionSnapshot(card.updatedAt + 1),
      worktrees: { removeIfLossless },
    });

    try {
      await service.start(context);
      service.onGatewayStart();
      await vi.waitFor(() => expect(removeIfLossless).toHaveBeenCalledOnce());

      expect((await restarted.store.get(card.id))?.metadata?.automation?.workspace).toEqual({
        kind: "worktree",
        path: SOURCE_PATH,
        branch: "main",
      });
    } finally {
      service.onGatewayStop();
      await service.stop?.(context);
      restarted.stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a retained worktree obligation and retries it after restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-cleanup-retained-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const managedPath = path.join(dir, "managed-worktree");
    fs.mkdirSync(managedPath);
    const initial = openStore(dbPath);
    const card = await createManagedCard(initial.store, { managedPath, status: "review" });
    initial.stores.close();
    const removeIfLossless = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        fs.rmSync(managedPath, { recursive: true });
        return true;
      });

    const retained = openStore(dbPath);
    const firstService = createWorkboardLifecycleService({
      store: retained.store,
      readSessions: doneSessionSnapshot(card.updatedAt),
      worktrees: { removeIfLossless },
    });
    await firstService.start(context);
    firstService.onGatewayStart();
    await vi.waitFor(() => expect(removeIfLossless).toHaveBeenCalledOnce());
    firstService.onGatewayStop();
    await firstService.stop?.(context);
    expect((await retained.store.get(card.id))?.metadata?.automation?.workspace).toMatchObject({
      path: managedPath,
      sourcePath: SOURCE_PATH,
    });
    retained.stores.close();

    const restarted = openStore(dbPath);
    const secondService = createWorkboardLifecycleService({
      store: restarted.store,
      readSessions: doneSessionSnapshot(card.updatedAt),
      worktrees: { removeIfLossless },
    });
    try {
      await secondService.start(context);
      secondService.onGatewayStart();
      await vi.waitFor(() => expect(removeIfLossless).toHaveBeenCalledTimes(2));
      expect((await restarted.store.get(card.id))?.metadata?.automation?.workspace).toEqual({
        kind: "worktree",
        path: SOURCE_PATH,
        branch: "main",
      });
    } finally {
      secondService.onGatewayStop();
      await secondService.stop?.(context);
      restarted.stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans a blocked pre-start worktree without an execution association", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-cleanup-blocked-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const initial = openStore(dbPath);
    const card = await createManagedCard(initial.store, {
      status: "blocked",
      withExecutionAssociation: false,
    });
    initial.stores.close();

    const restarted = openStore(dbPath);
    const readSessions = vi.fn();
    const removeIfLossless = vi.fn().mockResolvedValue(true);
    const service = createWorkboardLifecycleService({
      store: restarted.store,
      readSessions,
      worktrees: { removeIfLossless },
    });
    try {
      await service.start(context);
      service.onGatewayStart();
      await vi.waitFor(() => expect(removeIfLossless).toHaveBeenCalledOnce());

      expect(readSessions).not.toHaveBeenCalled();
      expect((await restarted.store.get(card.id))?.metadata?.automation?.workspace).toEqual({
        kind: "worktree",
        path: SOURCE_PATH,
        branch: "main",
      });
    } finally {
      service.onGatewayStop();
      await service.stop?.(context);
      restarted.stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not clean a matched card after a newer running attempt wins the race", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-cleanup-race-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const initial = openStore(dbPath);
    const card = await createManagedCard(initial.store);
    const newerSessionKey = "agent:newer:subagent:workboard-cleanup-recovery";
    const originalSync = initial.store.syncLifecycle.bind(initial.store);
    vi.spyOn(initial.store, "syncLifecycle").mockImplementationOnce(async (id, input) => {
      await initial.store.update(id, {
        sessionKey: newerSessionKey,
        runId: "newer-run",
        execution: execution(newerSessionKey, "newer-run", "running"),
      });
      return await originalSync(id, input);
    });
    const removeIfLossless = vi.fn().mockResolvedValue(true);

    try {
      await expect(
        syncWorkboardSubagentEnded({
          store: initial.store,
          worktrees: { removeIfLossless },
          event: {
            targetSessionKey: SESSION_KEY,
            runId: RUN_ID,
            endedAt: card.updatedAt + 1,
            outcome: "ok",
          },
        }),
      ).resolves.toBe(0);
      expect(removeIfLossless).not.toHaveBeenCalled();
      await expect(initial.store.get(card.id)).resolves.toMatchObject({
        status: "running",
        runId: "newer-run",
        execution: { status: "running", runId: "newer-run" },
      });
    } finally {
      initial.stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

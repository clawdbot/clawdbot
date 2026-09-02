// Archive lifecycle keeps session metadata and recoverable worktree contents in sync.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test, vi } from "vitest";
import type { SessionsPatchManyResult } from "../../packages/gateway-protocol/src/index.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import {
  managedWorktrees,
  ManagedWorktreeService,
  WorktreeSnapshotError,
} from "../agents/worktrees/service.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import {
  directSessionReq,
  loadSeededTranscriptEvents,
  sessionHookMocks,
} from "./test/server-sessions.test-helpers.js";
import { setupGatewaySessionsWorktreeTestHarness } from "./test/server-sessions.worktree-fixture.js";

const { createArchiveWorktreeFixture } = setupGatewaySessionsWorktreeTestHarness();
const execFileAsync = promisify(execFile);

test.each([
  ["sessions.patch", false],
  ["sessions.patchMany", false],
  ["sessions.patch", true],
] as const)(
  "%s archives the checkout and restores dirty work without deleting the conversation (already archived=%s)",
  async (method, alreadyArchived) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, sessionId, storePath, worktree, workspace } = fixture;
    await fs.writeFile(path.join(worktree.path, "committed.txt"), "unpushed work\n");
    await execFileAsync("git", ["-C", worktree.path, "add", "committed.txt"]);
    await execFileAsync("git", ["-C", worktree.path, "commit", "-m", "session work"]);
    const originalHead = (await execFileAsync("git", ["-C", worktree.path, "rev-parse", "HEAD"]))
      .stdout;
    await fs.writeFile(path.join(worktree.path, "README.md"), "tracked changes\n");
    await fs.writeFile(path.join(worktree.path, "draft.txt"), "untracked changes\n");
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
    if (alreadyArchived) {
      await patchSessionEntryCore({ storePath, sessionKey: key }, () => ({ archivedAt: 1 }), {
        skipMaintenance: true,
      });
    }
    const patch = (archived: boolean) =>
      directSessionReq(
        method,
        method === "sessions.patch"
          ? { key, expectedSessionId: sessionId, archived }
          : { targets: [{ key, expectedSessionId: sessionId }], patch: { archived } },
      );

    expect(await patch(true)).toMatchObject({ ok: true });
    expect(loadSessionEntry({ storePath, sessionKey: key })).toMatchObject({
      sessionId,
      archivedAt: expect.any(Number),
      worktree: { id: worktree.id },
    });
    await expect(fs.access(worktree.path)).rejects.toThrow();
    expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
      removedAt: expect.any(Number),
      snapshotRef: expect.stringMatching(/^refs\/openclaw\/snapshots\//),
    });
    expect(
      (await execFileAsync("git", ["-C", workspace, "worktree", "list", "--porcelain"])).stdout,
    ).not.toContain(worktree.path);
    await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);

    expect(await patch(false)).toMatchObject({ ok: true });
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
    expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
    await expect(fs.readFile(path.join(worktree.path, "README.md"), "utf8")).resolves.toBe(
      "tracked changes\n",
    );
    await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
      "untracked changes\n",
    );
    expect((await execFileAsync("git", ["-C", worktree.path, "rev-parse", "HEAD"])).stdout).toBe(
      originalHead,
    );
    await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
    const lease = await acquireWorktreeRunLease(worktree.id);
    await lease.release();
  },
);

test.each(["sessions.patch", "sessions.patchMany"] as const)(
  "%s preserves the checkout when the archive metadata write fails",
  async (method) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, sessionId, storePath, worktree } = fixture;
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
    await fs.writeFile(path.join(worktree.path, "README.md"), "uncommitted edit\n");
    await fs.writeFile(path.join(worktree.path, "draft.txt"), "untracked draft\n");
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    const { db } = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    // Fail the real write after async projection, when premature cleanup has already run.
    db.exec(`
      CREATE TEMP TRIGGER reject_archive_metadata
      BEFORE UPDATE OF entry_json ON session_nodes
      WHEN json_extract(NEW.entry_json, '$.archivedAt') IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected archive metadata failure');
      END;
    `);
    try {
      const outcome =
        method === "sessions.patch"
          ? await directSessionReq(method, { key, expectedSessionId: sessionId, archived: true })
          : (
              await directSessionReq<SessionsPatchManyResult>(method, {
                targets: [{ key, expectedSessionId: sessionId }],
                patch: { archived: true },
              })
            ).payload?.outcomes[0];
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", retryable: true },
      });
      expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
      expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
      await expect(fs.readFile(path.join(worktree.path, "README.md"), "utf8")).resolves.toBe(
        "uncommitted edit\n",
      );
      await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
        "untracked draft\n",
      );
      await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(
        transcript,
      );
    } finally {
      db.exec("DROP TRIGGER reject_archive_metadata");
    }
  },
);

test.each([
  ["sessions.patch", "busy"],
  ["sessions.patch", "snapshot-failed"],
  ["sessions.patchMany", "busy"],
  ["sessions.patchMany", "snapshot-failed"],
] as const)(
  "%s commits archives and permits cleanup retry when cleanup is %s",
  async (method, failure) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, sessionId, storePath, worktree } = fixture;
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
    const targets = [{ key, expectedSessionId: sessionId }];
    if (method === "sessions.patchMany") {
      const peer = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
        agentId: "main",
      });
      expect(peer.ok).toBe(true);
      targets.push({ key: peer.payload!.key, expectedSessionId: peer.payload!.sessionId });
    }
    const broadcastToConnIds = vi.fn();
    const context = {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["archive-observer"]),
    };
    onTestFinished(() => flushPendingSessionsChangedEvents());
    await fs.writeFile(path.join(worktree.path, "draft.txt"), "preserved for cleanup retry\n");
    const lease = failure === "busy" ? await acquireWorktreeRunLease(worktree.id) : undefined;
    const remove =
      failure === "snapshot-failed"
        ? vi
            .spyOn(managedWorktrees, "remove")
            .mockRejectedValueOnce(new WorktreeSnapshotError("snapshot unavailable"))
        : undefined;
    try {
      const archived = await directSessionReq<SessionsPatchManyResult>(
        method,
        method === "sessions.patch"
          ? { key, expectedSessionId: sessionId, archived: true }
          : { targets, patch: { archived: true } },
        { context },
      );
      const outcome = method === "sessions.patchMany" ? archived.payload?.outcomes[0] : archived;
      expect(outcome).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          retryable: false,
          message: expect.stringMatching(/Session archived.*worktree.*retry.*archive/i),
        },
      });
      if (method === "sessions.patchMany") {
        expect(archived.ok).toBe(true);
        expect(archived.payload?.outcomes.slice(1)).toEqual([{ key: targets[1]!.key, ok: true }]);
      }
      for (const target of targets) {
        expect(loadSessionEntry({ storePath, sessionKey: target.key })?.archivedAt).toEqual(
          expect.any(Number),
        );
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ sessionKey: target.key, archived: true }),
          expect.any(Set),
          expect.any(Object),
        );
        expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "patch",
            sessionKey: target.key,
            context: expect.objectContaining({
              sessionEntry: expect.objectContaining({ archivedAt: expect.any(Number) }),
            }),
          }),
        );
      }
      expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
      await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
        "preserved for cleanup retry\n",
      );
      await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(
        transcript,
      );
    } finally {
      remove?.mockRestore();
      await lease?.release();
    }
    const retried = await directSessionReq("sessions.patch", {
      key,
      expectedSessionId: sessionId,
      archived: true,
    });
    expect(retried).toMatchObject({ ok: true });
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toEqual(
      expect.any(Number),
    );
    expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toEqual(expect.any(Number));
    await expect(fs.access(worktree.path)).rejects.toThrow();
    await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
  },
);

test("automatic session archive snapshots the checkout after committing metadata and keeps its transcript", async () => {
  const fixture = await createArchiveWorktreeFixture();
  const { key, sessionId, storePath, worktree } = fixture;
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  await patchSessionEntryCore(
    { storePath, sessionKey: key },
    (entry) => ({
      ...entry!,
      updatedAt: old,
      lastInteractionAt: old,
      lastActivityAt: old,
      sessionStartedAt: old,
    }),
    { skipMaintenance: true, replaceEntry: true },
  );
  expect(loadSessionEntry({ storePath, sessionKey: key })?.updatedAt).toBe(old);
  const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
  await fs.writeFile(path.join(worktree.path, "draft.txt"), "automatic archive keeps work\n");

  const result = await applySessionEntryLifecycleMutation({
    agentId: "main",
    storePath,
    removals: [],
    maintenanceOverride: { mode: "enforce", archiveDashboardAfterMs: 1 },
  });

  expect(result.archived).toBe(1);
  expect(loadSessionEntry({ storePath, sessionKey: key })).toMatchObject({
    sessionId,
    archivedAt: expect.any(Number),
    worktree: { id: worktree.id },
  });
  await expect(fs.access(worktree.path)).rejects.toThrow();
  expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
    removedAt: expect.any(Number),
    snapshotRef: expect.stringMatching(/^refs\/openclaw\/snapshots\//),
  });
  await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
});

test.each(["unarchived", "rearchived"] as const)(
  "automatic archive preserves a checkout whose owner was %s while cleanup awaited",
  async (change) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, storePath, worktree } = fixture;
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await patchSessionEntryCore(
      { storePath, sessionKey: key },
      (entry) => ({
        ...entry!,
        updatedAt: old,
        lastInteractionAt: old,
        lastActivityAt: old,
        sessionStartedAt: old,
      }),
      { skipMaintenance: true, replaceEntry: true },
    );
    expect(loadSessionEntry({ storePath, sessionKey: key })?.updatedAt).toBe(old);
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
    const successorArchive = change === "rearchived" ? Date.now() + 1000 : undefined;
    let archivedBeforeCleanup: number | undefined;
    const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
    const remove = vi
      .spyOn(ManagedWorktreeService.prototype, "remove")
      .mockImplementationOnce(async (params) => {
        archivedBeforeCleanup = loadSessionEntry({ storePath, sessionKey: key })?.archivedAt;
        await patchSessionEntryCore(
          { storePath, sessionKey: key },
          () => ({ archivedAt: successorArchive }),
          { skipMaintenance: true },
        );
        return await originalRemove(params);
      });
    try {
      const result = await applySessionEntryLifecycleMutation({
        agentId: "main",
        storePath,
        removals: [],
        maintenanceOverride: { mode: "enforce", archiveDashboardAfterMs: 1 },
      });
      expect(result.archived).toBe(1);
      expect(archivedBeforeCleanup).toEqual(expect.any(Number));
      expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBe(successorArchive);
      expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
      await expect(fs.access(worktree.path)).resolves.toBeUndefined();
      await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(
        transcript,
      );
    } finally {
      remove.mockRestore();
    }
  },
);

test.each(["checkout-failed", "expired", "source-missing"] as const)(
  "sessions.patch keeps an archived conversation when its worktree cannot be restored (%s)",
  async (failure) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, sessionId, storePath, worktree, workspace } = fixture;
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
    await managedWorktrees.remove({ id: worktree.id, reason: "session-archive" });
    await patchSessionEntryCore(
      { storePath, sessionKey: key },
      (entry) => ({
        ...entry!,
        archivedAt: 1,
      }),
      { skipMaintenance: true },
    );
    if (failure === "expired") {
      await new ManagedWorktreeService({ now: () => Date.now() + 31 * 24 * 60 * 60 * 1000 }).gc();
    } else if (failure === "source-missing") {
      await fs.rename(workspace, `${workspace}-offline`);
    }
    const restore =
      failure === "checkout-failed"
        ? vi
            .spyOn(managedWorktrees, "restore")
            .mockRejectedValueOnce(new Error("checkout unavailable"))
        : undefined;
    try {
      const restored = await directSessionReq("sessions.patch", {
        key,
        expectedSessionId: sessionId,
        archived: false,
      });
      expect(restored).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", retryable: true },
      });
      expect(restored.error?.message).toContain("worktree");
      expect(restored.error?.message).toContain(
        failure === "checkout-failed" ? "Free disk space" : "new worktree task",
      );
      if (failure === "expired") {
        expect(restored.error?.message).toContain("expired");
      }
      if (failure === "source-missing") {
        expect(restored.error?.message).toContain("source repository is missing");
      }
      await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(
        transcript,
      );
      expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBe(1);
      await expect(fs.access(worktree.path)).rejects.toThrow();
    } finally {
      restore?.mockRestore();
    }
  },
);

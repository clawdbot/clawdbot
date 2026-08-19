import { expect } from "vitest";
import type { runSqliteSessionsTranscriptsFlipProof } from "./sqlite-sessions-transcripts-flip-proof.ts";

type SqliteFlipProofReport = Awaited<ReturnType<typeof runSqliteSessionsTranscriptsFlipProof>>;

export function assertSqliteFlipProofCore(report: SqliteFlipProofReport): void {
  expect(report.failures).toEqual([]);
  expect(report.ok).toBe(true);
  expect(
    report.checkpoints
      .filter((checkpoint) => checkpoint.label !== "seeded-legacy-store")
      .every((checkpoint) => checkpoint.activeJsonl.length === 0),
  ).toBe(true);
  expect(
    report.checkpoints.some(
      (checkpoint) =>
        checkpoint.label === "seeded-legacy-store" && checkpoint.legacyStateJsonl.length > 0,
    ),
  ).toBe(true);
  expect(
    report.checkpoints
      .filter((checkpoint) => checkpoint.label !== "seeded-legacy-store")
      .every((checkpoint) => checkpoint.legacyStateJsonl.length === 0),
  ).toBe(true);
  expect(report.checkpoints.some((checkpoint) => checkpoint.label === "after-doctor-fix")).toBe(
    false,
  );
  expect(
    report.checkpoints.some(
      (checkpoint) =>
        checkpoint.label === "after-startup-import" &&
        checkpoint.gatewayLogTail?.includes(
          "session: imported legacy session metadata/transcripts into SQLite",
        ) &&
        report.oldStateSessionKeys.every((key) =>
          checkpoint.sqlite.trackedEntries.some((entry) => entry.sessionKey === key),
        ) &&
        checkpoint.sqlite.sessionEntries >= 7 &&
        checkpoint.sqlite.transcriptEvents >= 13,
    ),
  ).toBe(true);
  const startupImportCheckpoint = report.checkpoints.find(
    (checkpoint) => checkpoint.label === "after-startup-import",
  );
  expect(
    startupImportCheckpoint?.archiveArtifacts.some(
      (artifact) =>
        artifact.path.includes(`${report.legacySessionId}.trajectory.jsonl`) &&
        artifact.textTail?.includes("trajectory") === true,
    ),
  ).toBe(true);
  expect(
    report.checkpoints.some(
      (checkpoint) =>
        checkpoint.label === "after-chat-send" &&
        checkpoint.sqlite.trackedEntries.some(
          (entry) => entry.sessionKey === report.resetSessionKey && entry.transcriptEvents >= 3,
        ),
    ),
  ).toBe(true);
  expect(
    report.checkpoints.some(
      (checkpoint) =>
        checkpoint.label === "after-full-agent-turn" &&
        checkpoint.sqlite.trackedEntries.some(
          (entry) => entry.sessionKey === report.fullTurnSessionKey && entry.transcriptEvents >= 2,
        ),
    ),
  ).toBe(true);
  const idempotenceCheckpoint = report.checkpoints.find(
    (checkpoint) => checkpoint.label === "after-doctor-import-idempotence",
  );
  expect(idempotenceCheckpoint?.doctor).toMatchObject({
    code: 0,
    mode: "import",
    totals: expect.objectContaining({
      importedEntries: 0,
      importedTranscriptEvents: 0,
    }),
  });
  const resetCheckpoint = report.checkpoints.find(
    (checkpoint) => checkpoint.label === "after-sessions-reset",
  );
  const resetArchive = resetCheckpoint?.archiveArtifacts.find(
    (artifact) =>
      artifact.archiveReason === "reset" && artifact.archiveSessionId === report.legacySessionId,
  );
  expect(resetArchive).toBeUndefined();
  expect(resetCheckpoint?.sqlite.transcriptEvents ?? 0).toBeGreaterThan(0);
  const sharedFirstCheckpoint = report.checkpoints.find(
    (checkpoint) => checkpoint.label === "after-shared-first-delete",
  );
  expect(
    sharedFirstCheckpoint?.archiveArtifacts.some(
      (artifact) =>
        artifact.archiveReason === "deleted" &&
        artifact.archiveSessionId === "sqlite-shared-session",
    ),
  ).toBe(false);
  const concurrentCheckpoint = report.checkpoints.find(
    (checkpoint) => checkpoint.label === "after-concurrent-multi-client",
  );
  expect(concurrentCheckpoint).toBeDefined();
  const concurrentSend = concurrentCheckpoint?.sqlite.trackedEntries.find(
    (entry) => entry.sessionKey === report.concurrentSendSessionKey,
  );
  expect(concurrentSend?.transcriptEvents).toBeGreaterThanOrEqual(2);
  expect(
    concurrentCheckpoint?.sqlite.trackedEntries.some(
      (entry) => entry.sessionKey === report.concurrentResetSessionKey && entry.sessionId,
    ),
  ).toBe(true);
  expect(
    concurrentCheckpoint?.sqlite.trackedEntries.some(
      (entry) => entry.sessionKey === report.concurrentDeleteSessionKey,
    ),
  ).toBe(false);
  expect(report.checkpoints.map((checkpoint) => checkpoint.label)).toEqual([
    "seeded-legacy-store",
    "after-startup-import",
    "after-doctor-inspect",
    "after-doctor-validate",
    "after-rollback-restore",
    "after-gateway-restart",
    "after-chat-send",
    "after-full-agent-turn",
    "after-doctor-import-idempotence",
    "after-downgrade-reupgrade-import",
    "after-sqlite-busy-contention",
    "after-concurrent-multi-client",
    "after-sessions-reset",
    "after-second-startup-after-reset",
    "after-transcript-append",
    "after-sessions-delete",
    "after-shared-first-delete",
    "after-shared-final-delete",
    "after-final-doctor-inspect",
  ]);
  expect(
    startupImportCheckpoint?.archiveArtifacts.some(
      (artifact) =>
        artifact.path.includes("old-orphan.deleted.jsonl") &&
        artifact.textTail?.includes("old-orphan") === true,
    ),
  ).toBe(true);
  expect(report.rollbackRestore).toMatchObject({
    archivedBeforeRestore: true,
    failedManifestIssueCode: "e2e_forced_post_archive_failure",
    sourceRestored: true,
    sqliteStillExists: true,
  });
  expect(report.rollbackRestore?.manifestPath).toContain("session-sqlite-migration-runs");
  expect(
    report.rollbackRestore?.restoredFiles.some((filePath) =>
      filePath.replaceAll("\\", "/").endsWith("/sqlite-rollback-restore.jsonl"),
    ),
  ).toBe(true);
  expect(
    report.rollbackRestore?.idempotentRestoreSkippedFiles.some((filePath) =>
      filePath.replaceAll("\\", "/").endsWith("/sqlite-rollback-restore.jsonl"),
    ),
  ).toBe(true);
  expect(report.scaleMigration).toMatchObject({
    minTranscriptEventsPerSession: 4,
    seededEvents: 96,
    seededSessions: 24,
  });
  expect(report.scaleMigration?.importedSessionKeys).toHaveLength(24);
  expect(report.scaleMigration?.startupImportElapsedMs).toBeGreaterThanOrEqual(0);
  expect(
    report.checkpoints.some(
      (checkpoint) =>
        checkpoint.label === "after-full-agent-turn" &&
        checkpoint.sqlite.trackedEntries.some(
          (entry) =>
            entry.sessionKey === report.fullTurnSessionKey &&
            entry.transcriptEvents >= 2 &&
            entry.trajectoryEvents >= 1,
        ),
    ),
  ).toBe(true);
  expect(report.downgradeReupgrade).toMatchObject({
    activeJsonlArchived: true,
    doctorImportedEntries: 1,
    doctorImportedTranscriptEvents: 2,
    sessionId: "sqlite-downgrade-reupgrade",
    sessionKey: "agent:main:dashboard:sqlite-downgrade-reupgrade",
    trajectoryPointerArchived: true,
    trajectoryPointerSourceRemoved: true,
    trajectorySidecarArchived: true,
    trajectorySidecarSourceRemoved: true,
    transcriptEvents: 2,
  });
  const downgradeCheckpoint = report.checkpoints.find(
    (checkpoint) => checkpoint.label === "after-downgrade-reupgrade-import",
  );
  expect(
    downgradeCheckpoint?.archiveArtifacts.some(
      (artifact) =>
        artifact.path.includes("sqlite-downgrade-reupgrade.trajectory.jsonl") &&
        artifact.textTail?.includes("trajectory") === true,
    ),
  ).toBe(true);
  expect(
    downgradeCheckpoint?.archiveArtifacts.some((artifact) =>
      artifact.path.includes("sqlite-downgrade-reupgrade.trajectory-path.json"),
    ),
  ).toBe(true);
  expect(
    report.checkpoints.some(
      (checkpoint) =>
        checkpoint.label === "after-downgrade-reupgrade-import" &&
        checkpoint.sqlite.trackedEntries.some(
          (entry) =>
            entry.sessionKey === "agent:main:dashboard:sqlite-downgrade-reupgrade" &&
            entry.transcriptEvents === 2,
        ),
    ),
  ).toBe(true);
  expect(report.busyContention).toMatchObject({
    childExitCode: 0,
    childSignal: null,
    holdMs: 500,
    sessionId: "sqlite-busy-contention",
    sessionKey: "agent:main:dashboard:sqlite-busy-contention",
    transcriptEvents: 2,
  });
  expect(report.busyContention?.elapsedMs).toBeGreaterThanOrEqual(250);
  expect(report.secondStartupAfterReset).toMatchObject({
    activeJsonlForSessionExists: false,
    historyContainsPostResetAppend: true,
    sessionKey: report.resetSessionKey,
  });
  expect(report.secondStartupAfterReset?.transcriptEvents).toBeGreaterThanOrEqual(1);
  expect(
    report.checkpoints.some(
      (checkpoint) =>
        checkpoint.label === "after-transcript-append" &&
        checkpoint.sqlite.trackedEntries.some(
          (entry) => entry.sessionKey === report.resetSessionKey && entry.transcriptEvents >= 1,
        ),
    ),
  ).toBe(true);
  const deleteCheckpoint = report.checkpoints.find(
    (checkpoint) => checkpoint.label === "after-sessions-delete",
  );
  const deleteArchive = deleteCheckpoint?.archiveArtifacts.find(
    (artifact) =>
      artifact.archiveReason === "deleted" && artifact.archiveSessionId === "sqlite-delete-session",
  );
  expect(deleteArchive?.messageTexts).toContain("delete me");
  const sharedFinalCheckpoint = report.checkpoints.find(
    (checkpoint) => checkpoint.label === "after-shared-final-delete",
  );
  const sharedFinalArchive = sharedFinalCheckpoint?.archiveArtifacts.find(
    (artifact) =>
      artifact.archiveReason === "deleted" && artifact.archiveSessionId === "sqlite-shared-session",
  );
  const retainedSharedImportSources = sharedFinalCheckpoint?.archiveArtifacts.filter(
    (artifact) =>
      artifact.path.includes("session-sqlite-import-archive") &&
      (artifact.path.includes("sqlite-shared-a.jsonl") ||
        artifact.path.includes("sqlite-shared-b.jsonl")),
  );
  expect(
    sharedFinalArchive?.messageTexts?.includes("shared") ||
      (retainedSharedImportSources?.length === 2 &&
        retainedSharedImportSources.every((artifact) =>
          artifact.messageTexts?.some((text) => text.includes("shared")),
        )),
  ).toBe(true);
  expect(
    report.checkpoints.some(
      (checkpoint) =>
        checkpoint.label === "after-shared-final-delete" && checkpoint.archiveArtifacts.length > 0,
    ),
  ).toBe(true);
}

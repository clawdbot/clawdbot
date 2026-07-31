// SQLite sessions/transcripts flip proof test runs the script-style gateway lifecycle probe.
import { describe, expect, it } from "vitest";
import { assertSqliteFlipProofCore } from "../helpers/sqlite-sessions-transcripts-flip-proof-assertions.ts";
import { runSqliteSessionsTranscriptsFlipProof } from "../helpers/sqlite-sessions-transcripts-flip-proof.ts";

describe("SQLite sessions/transcripts flip proof harness", () => {
  it("proves isolated gateway lifecycle state stays SQLite-first", async () => {
    const report = await runSqliteSessionsTranscriptsFlipProof();

    assertSqliteFlipProofCore(report);
    expect(report.checkpoints.map((checkpoint) => checkpoint.label)).toEqual([
      "seeded-legacy-store",
      "after-startup-import",
      "after-doctor-inspect",
      "after-doctor-validate",
      "after-rollback-restore",
      "after-gateway-restart",
      "after-chat-send",
      "after-full-agent-turn",
      "after-manual-compaction",
      "after-plugin-sdk-consumer",
      "after-cleanup-pruning",
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
    const startupImportCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-startup-import",
    );
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
        filePath.endsWith("/sqlite-rollback-restore.jsonl"),
      ),
    ).toBe(true);
    expect(
      report.rollbackRestore?.idempotentRestoreSkippedFiles.some((filePath) =>
        filePath.endsWith("/sqlite-rollback-restore.jsonl"),
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
    expect(report.manualCompaction).toMatchObject({
      checkpointCount: 1,
      compacted: true,
      sessionKey: report.manualCompactionSessionKey,
    });
    expect(report.manualCompaction?.transcriptIdentity).toBe(report.manualCompactionSessionKey);
    expect(report.manualCompaction?.rowCountBefore).toBeGreaterThanOrEqual(2);
    expect(report.manualCompaction?.rowCountAfter).toBeGreaterThanOrEqual(1);
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-manual-compaction" &&
          checkpoint.activeJsonl.length === 0 &&
          checkpoint.sqlite.trackedEntries.some(
            (entry) =>
              entry.sessionKey === report.manualCompactionSessionKey &&
              Array.isArray(entry.entry?.compactionCheckpoints) &&
              entry.entry.compactionCheckpoints.length >= 1,
          ),
      ),
    ).toBe(true);
    expect(report.pluginSdkConsumer).toMatchObject({
      activeTrajectoryPointerForSessionExists: false,
      activeTrajectoryRuntimeSidecarForSessionExists: false,
      activeTrajectorySessionSidecarForSessionExists: false,
    });
    expect(report.pluginSdkConsumer?.sessionIdentity).toBe(report.pluginSdkSessionKey);
    expect(report.pluginSdkConsumer?.listedSessionKeys).toContain(report.pluginSdkSessionKey);
    expect(report.pluginSdkConsumer?.transcriptEventsAfterAppend).toBeGreaterThan(
      report.pluginSdkConsumer?.transcriptEventsBeforeAppend ?? 0,
    );
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-plugin-sdk-consumer" &&
          checkpoint.sqlite.trajectoryRuntimeEvents >= 1 &&
          checkpoint.sqlite.trackedEntries.some(
            (entry) =>
              entry.sessionKey === report.pluginSdkSessionKey &&
              entry.trajectoryEvents >= 1 &&
              entry.transcriptEvents >= 3,
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
        artifact.archiveReason === "deleted" &&
        artifact.archiveSessionId === "sqlite-delete-session",
    );
    expect(deleteArchive?.messageTexts).toContain("delete me");
    const sharedFinalCheckpoint = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-shared-final-delete",
    );
    const sharedFinalArchive = sharedFinalCheckpoint?.archiveArtifacts.find(
      (artifact) =>
        artifact.archiveReason === "deleted" &&
        artifact.archiveSessionId === "sqlite-shared-session",
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
          checkpoint.label === "after-shared-first-delete" &&
          checkpoint.sqlite.trackedEntries.some(
            (entry) => entry.sessionKey === report.sharedSessionKeys[1],
          ),
      ),
    ).toBe(true);
    expect(
      report.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "after-shared-final-delete" &&
          checkpoint.archiveArtifacts.length > 0,
      ),
    ).toBe(true);
  }, 180_000);
});

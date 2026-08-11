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
}

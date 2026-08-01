// Doctor-only import for the retired ACP replay JSON ledger.
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { isRecord } from "../utils.js";
import { withFileLock } from "./file-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_LEDGER_VERSION = 1;
const LEGACY_LEDGER_LOCK_OPTIONS = {
  retries: {
    retries: 8,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 5_000,
    randomize: true,
  },
  stale: 15_000,
  staleRecovery: "fail-closed",
} as const;

type LegacyAcpReplayEvent = {
  seq: number;
  at: number;
  sessionId: string;
  sessionKey: string;
  runId?: string;
  update: SessionUpdate;
};

type LegacyAcpReplaySession = {
  sessionId: string;
  sessionKey: string;
  cwd: string;
  complete: boolean;
  createdAt: number;
  updatedAt: number;
  nextSeq: number;
  events: LegacyAcpReplayEvent[];
};

type LegacySourceIdentity = {
  dev: number | bigint;
  ino: number | bigint;
  mtimeMs: number | bigint;
  sha256: string;
  size: number | bigint;
};

type AcpReplayMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "acp_replay_events" | "acp_replay_sessions"
>;

function resolveLegacyAcpReplayLedgerPath(stateDir: string): string {
  return path.join(stateDir, "acp", "event-ledger.json");
}

function resolveLegacyAcpReplayClaimPath(sourcePath: string): string {
  return `${sourcePath}.doctor-import`;
}

/** Detect the retired ledger only when an explicit doctor flow opts in. */
export function detectLegacyAcpReplayLedger(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["acpReplayLedger"] {
  const sourcePath = resolveLegacyAcpReplayLedgerPath(params.stateDir);
  const claimPath = resolveLegacyAcpReplayClaimPath(sourcePath);
  return {
    sourcePath,
    hasLegacy:
      params.doctorOnlyStateMigrations === true &&
      (fsSync.existsSync(sourcePath) || fsSync.existsSync(claimPath)),
  };
}

function parseLegacyEvent(raw: unknown, sessionId: string): LegacyAcpReplayEvent {
  if (!isRecord(raw) || !isRecord(raw.update)) {
    throw new Error(`legacy ACP replay session ${sessionId} contains an invalid event`);
  }
  if (
    typeof raw.seq !== "number" ||
    !Number.isInteger(raw.seq) ||
    raw.seq < 1 ||
    typeof raw.at !== "number" ||
    !Number.isFinite(raw.at) ||
    raw.sessionId !== sessionId ||
    typeof raw.sessionKey !== "string" ||
    typeof raw.update.sessionUpdate !== "string"
  ) {
    throw new Error(`legacy ACP replay session ${sessionId} contains an invalid event`);
  }
  if (raw.runId !== undefined && (typeof raw.runId !== "string" || raw.runId.length === 0)) {
    throw new Error(`legacy ACP replay session ${sessionId} contains an invalid run id`);
  }
  return {
    seq: raw.seq,
    at: raw.at,
    sessionId,
    sessionKey: raw.sessionKey,
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    update: structuredClone(raw.update) as SessionUpdate,
  };
}

function parseLegacySession(raw: unknown, expectedSessionId: string): LegacyAcpReplaySession {
  if (
    !isRecord(raw) ||
    raw.sessionId !== expectedSessionId ||
    typeof raw.sessionKey !== "string" ||
    typeof raw.cwd !== "string" ||
    typeof raw.complete !== "boolean" ||
    typeof raw.createdAt !== "number" ||
    !Number.isFinite(raw.createdAt) ||
    typeof raw.updatedAt !== "number" ||
    !Number.isFinite(raw.updatedAt) ||
    typeof raw.nextSeq !== "number" ||
    !Number.isInteger(raw.nextSeq) ||
    raw.nextSeq < 1 ||
    !Array.isArray(raw.events)
  ) {
    throw new Error(`legacy ACP replay session ${expectedSessionId} is invalid`);
  }
  const events = raw.events.map((event) => parseLegacyEvent(event, expectedSessionId));
  const sequences = new Set(events.map((event) => event.seq));
  const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  if (sequences.size !== events.length || raw.nextSeq <= maxSeq) {
    throw new Error(`legacy ACP replay session ${expectedSessionId} has invalid sequencing`);
  }
  return {
    sessionId: expectedSessionId,
    sessionKey: raw.sessionKey,
    cwd: raw.cwd,
    complete: raw.complete,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    nextSeq: raw.nextSeq,
    events: events.toSorted((left, right) => left.seq - right.seq),
  };
}

function parseLegacyLedger(raw: string): LegacyAcpReplaySession[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.version !== LEGACY_LEDGER_VERSION || !isRecord(parsed.sessions)) {
    throw new Error("legacy ACP replay ledger must be a version 1 JSON object");
  }
  return Object.entries(parsed.sessions).map(([sessionId, session]) =>
    parseLegacySession(session, sessionId),
  );
}

function estimateSessionBytes(session: LegacyAcpReplaySession): number {
  return session.sessionId.length + session.sessionKey.length + session.cwd.length + 32;
}

function estimateEventBytes(event: LegacyAcpReplayEvent, updateJson: string): number {
  return (
    event.sessionId.length +
    event.sessionKey.length +
    updateJson.length +
    (event.runId?.length ?? 0) +
    32
  );
}

function sourceIdentity(
  stat: Awaited<ReturnType<typeof fs.lstat>>,
  raw: string,
): LegacySourceIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256").update(raw).digest("hex"),
    size: stat.size,
  };
}

function sourceIdentityMatches(left: LegacySourceIdentity, right: LegacySourceIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function reconcileCanonicalSession(db: DatabaseSync, session: LegacyAcpReplaySession): boolean {
  const replayDb = getNodeSqliteKysely<AcpReplayMigrationDatabase>(db);
  const stored = executeSqliteQueryTakeFirstSync(
    db,
    replayDb
      .selectFrom("acp_replay_sessions")
      .select([
        "session_key",
        "cwd",
        "complete",
        "created_at",
        "updated_at",
        "next_seq",
        "estimated_bytes",
      ])
      .where("session_id", "=", session.sessionId),
  );
  if (
    !stored ||
    stored.session_key !== session.sessionKey ||
    stored.cwd !== session.cwd ||
    stored.complete !== (session.complete ? 1 : 0) ||
    stored.created_at !== session.createdAt ||
    stored.updated_at !== session.updatedAt ||
    stored.next_seq !== session.nextSeq
  ) {
    return false;
  }

  const storedEvents = executeSqliteQuerySync(
    db,
    replayDb
      .selectFrom("acp_replay_events")
      .select(["seq", "at", "session_key", "run_id", "update_json", "estimated_bytes"])
      .where("session_id", "=", session.sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  if (storedEvents.length !== session.events.length) {
    return false;
  }

  const expectedEventBytes: number[] = [];
  for (const [index, event] of session.events.entries()) {
    const storedEvent = storedEvents[index];
    if (!storedEvent) {
      return false;
    }
    let storedUpdate: unknown;
    try {
      storedUpdate = JSON.parse(storedEvent.update_json);
    } catch {
      return false;
    }
    if (
      storedEvent.seq !== event.seq ||
      storedEvent.at !== event.at ||
      storedEvent.session_key !== event.sessionKey ||
      storedEvent.run_id !== (event.runId ?? null) ||
      !isDeepStrictEqual(storedUpdate, event.update)
    ) {
      return false;
    }
    expectedEventBytes.push(estimateEventBytes(event, JSON.stringify(event.update)));
  }

  for (const [index, event] of session.events.entries()) {
    const expectedBytes = expectedEventBytes[index];
    if (expectedBytes !== undefined && storedEvents[index]?.estimated_bytes !== expectedBytes) {
      executeSqliteQuerySync(
        db,
        replayDb
          .updateTable("acp_replay_events")
          .set({ estimated_bytes: expectedBytes })
          .where("session_id", "=", session.sessionId)
          .where("seq", "=", event.seq),
      );
    }
  }
  const expectedSessionBytes =
    estimateSessionBytes(session) + expectedEventBytes.reduce((sum, value) => sum + value, 0);
  if (stored.estimated_bytes !== expectedSessionBytes) {
    executeSqliteQuerySync(
      db,
      replayDb
        .updateTable("acp_replay_sessions")
        .set({ estimated_bytes: expectedSessionBytes })
        .where("session_id", "=", session.sessionId),
    );
  }
  return true;
}

/** Import, verify, and remove the retired JSON ledger during explicit doctor repair. */
export async function migrateLegacyAcpReplayLedger(params: {
  detected: LegacyStateDetection["acpReplayLedger"];
  stateDir: string;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  try {
    const result = await withFileLock(
      params.detected.sourcePath,
      LEGACY_LEDGER_LOCK_OPTIONS,
      async () => {
        const claimPath = resolveLegacyAcpReplayClaimPath(params.detected.sourcePath);
        const resumedClaim = fsSync.existsSync(claimPath);
        const activePath = resumedClaim ? claimPath : params.detected.sourcePath;
        const before = await fs.lstat(activePath);
        if (!before.isFile() || before.isSymbolicLink()) {
          throw new Error("legacy ACP replay source is not a regular non-symlink file");
        }
        const raw = await fs.readFile(activePath, "utf8");
        const identity = sourceIdentity(before, raw);
        const sessions = parseLegacyLedger(raw);
        let importedSessions = 0;
        let importedEvents = 0;
        let retainedSessions = 0;
        let claimedThisRun = false;

        try {
          if (!resumedClaim) {
            await fs.rename(params.detected.sourcePath, claimPath);
            claimedThisRun = true;
            const claimedStat = await fs.lstat(claimPath);
            const claimedRaw = await fs.readFile(claimPath, "utf8");
            if (!sourceIdentityMatches(identity, sourceIdentity(claimedStat, claimedRaw))) {
              throw new Error("legacy ACP replay source changed while doctor was claiming it");
            }
          }

          runOpenClawStateWriteTransaction(
            ({ db }) => {
              const replayDb = getNodeSqliteKysely<AcpReplayMigrationDatabase>(db);
              const missingSessions: LegacyAcpReplaySession[] = [];
              for (const session of sessions) {
                const existing = executeSqliteQueryTakeFirstSync(
                  db,
                  replayDb
                    .selectFrom("acp_replay_sessions")
                    .select("session_id")
                    .where("session_id", "=", session.sessionId),
                );
                if (existing) {
                  if (!reconcileCanonicalSession(db, session)) {
                    throw new Error(
                      `canonical ACP replay session ${session.sessionId} conflicts with the legacy source`,
                    );
                  }
                  retainedSessions += 1;
                  continue;
                }
                missingSessions.push(session);
              }

              for (const session of missingSessions) {
                let estimatedBytes = estimateSessionBytes(session);
                executeSqliteQuerySync(
                  db,
                  replayDb.insertInto("acp_replay_sessions").values({
                    session_id: session.sessionId,
                    session_key: session.sessionKey,
                    cwd: session.cwd,
                    complete: session.complete ? 1 : 0,
                    created_at: session.createdAt,
                    updated_at: session.updatedAt,
                    next_seq: session.nextSeq,
                    estimated_bytes: estimatedBytes,
                  }),
                );
                for (const event of session.events) {
                  const updateJson = JSON.stringify(event.update);
                  const eventBytes = estimateEventBytes(event, updateJson);
                  executeSqliteQuerySync(
                    db,
                    replayDb.insertInto("acp_replay_events").values({
                      session_id: event.sessionId,
                      seq: event.seq,
                      at: event.at,
                      session_key: event.sessionKey,
                      run_id: event.runId ?? null,
                      update_json: updateJson,
                      estimated_bytes: eventBytes,
                    }),
                  );
                  estimatedBytes += eventBytes;
                  importedEvents += 1;
                }
                executeSqliteQuerySync(
                  db,
                  replayDb
                    .updateTable("acp_replay_sessions")
                    .set({ estimated_bytes: estimatedBytes })
                    .where("session_id", "=", session.sessionId),
                );
                if (!reconcileCanonicalSession(db, session)) {
                  throw new Error(
                    `failed verifying imported ACP replay session ${session.sessionId}`,
                  );
                }
                importedSessions += 1;
              }
            },
            { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
          );
          await fs.unlink(claimPath);
          return {
            importedSessions,
            importedEvents,
            retainedSessions,
            pendingSource: fsSync.existsSync(params.detected.sourcePath),
          };
        } catch (error) {
          if (claimedThisRun && !fsSync.existsSync(params.detected.sourcePath)) {
            await fs.rename(claimPath, params.detected.sourcePath).catch(() => {});
          }
          throw error;
        }
      },
    );
    changes.push(
      `Migrated ${result.importedSessions} ACP replay session(s) and ${result.importedEvents} event(s) → shared SQLite state`,
    );
    if (result.retainedSessions > 0) {
      changes.push(
        `Kept ${result.retainedSessions} existing ACP replay session(s) from shared SQLite state`,
      );
    }
    changes.push(`Removed retired ACP replay ledger ${params.detected.sourcePath}`);
    if (result.pendingSource) {
      warnings.push(
        `A newer ACP replay ledger remains at ${params.detected.sourcePath}; rerun doctor to migrate it`,
      );
    }
  } catch (error) {
    warnings.push(
      `Failed migrating legacy ACP replay ledger ${params.detected.sourcePath}: ${String(error)}`,
    );
  }
  return { changes, warnings };
}

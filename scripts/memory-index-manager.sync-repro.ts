import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeAllMemorySearchManagers,
  getMemorySearchManager,
} from "../extensions/memory-core/src/memory/index.ts";

const proofRoot = process.argv[2];
const exactHead = process.argv[3];
if (!proofRoot || !exactHead?.match(/^[0-9a-f]{40}$/)) {
  throw new Error("proof root and exact 40-character head are required");
}
const observedHead = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (observedHead !== exactHead) {
  throw new Error(`exact head mismatch: expected ${exactHead}, observed ${observedHead}`);
}
const dirtyState = execFileSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).trim();
if (dirtyState) {
  throw new Error("the production repro requires a clean exact-head worktree");
}

const agentId = "main";
const stateDir = path.join(proofRoot, "state");
const workspaceDir = path.join(proofRoot, "workspace");
const markers = {
  blocker: "BLOCKER_LOCKED_SYNC_729",
  retained: "RETAINED_RETRY_TARGET_729",
  trigger: "CONCURRENT_TRIGGER_TARGET_729",
  archive: "RETAINED_ARCHIVE_TARGET_729",
};

Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Proof workspace\n");

const cfg: OpenClawConfig = {
  memory: {
    search: {
      provider: "none",
      sources: ["sessions"],
      rememberAcrossConversations: true,
      store: { vector: { enabled: false } },
      query: { minScore: 0 },
    },
  },
  agents: {
    defaults: { workspace: workspaceDir },
    list: [{ id: agentId, default: true }],
  },
};

async function seedSession(sessionId: string, marker: string): Promise<string> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = `agent:${agentId}:proof:${sessionId}`;
  await fs.mkdir(sessionsDir, { recursive: true });
  await upsertSessionEntry({
    agentId,
    sessionKey,
    storePath,
    entry: { sessionId, updatedAt: Date.now() },
  });
  await appendSessionTranscriptMessageByIdentity({
    agentId,
    sessionId,
    sessionKey,
    storePath,
    message: {
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: marker }],
    },
  });
  return sessionKey;
}

function openExclusiveLock(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 0");
  db.exec("BEGIN EXCLUSIVE");
  return db;
}

function releaseExclusiveLock(db: DatabaseSync | null): void {
  if (!db) {
    return;
  }
  try {
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
}

function describeSqliteFailure(failure: unknown): string {
  const details = [String(failure)];
  if (failure && typeof failure === "object") {
    const record = failure as Record<string, unknown>;
    for (const key of ["message", "code"] as const) {
      if (typeof record[key] === "string") {
        details.push(record[key]);
      }
    }
    if (record.cause && typeof record.cause === "object") {
      const cause = record.cause as Record<string, unknown>;
      for (const key of ["message", "code"] as const) {
        if (typeof cause[key] === "string") {
          details.push(cause[key]);
        }
      }
    }
  }
  return details.join(" ");
}

function isSqliteLockFailure(failure: unknown): boolean {
  return /SQLITE_(?:BUSY|LOCKED)|database is (?:busy|locked)/i.test(describeSqliteFailure(failure));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

let lock: DatabaseSync | null = null;
try {
  const result = await getMemorySearchManager({ cfg, agentId });
  if (!result.manager) {
    throw new Error(`memory manager unavailable: ${result.error ?? "unknown"}`);
  }
  const manager = result.manager;
  const sync = manager.sync?.bind(manager);
  if (!sync) {
    throw new Error("memory manager sync is unavailable");
  }
  await sync({ reason: "proof-baseline", force: true });

  const blockerKey = await seedSession("proof-blocker", markers.blocker);
  const retainedKey = await seedSession("proof-retained", markers.retained);
  const triggerKey = await seedSession("proof-trigger", markers.trigger);
  const archiveFile = path.join(
    resolveSessionTranscriptsDirForAgent(agentId),
    "proof-archive.jsonl.deleted.2026-07-29T00-00-00.000Z",
  );
  await fs.writeFile(
    archiveFile,
    [
      JSON.stringify({
        type: "session",
        id: "proof-archive",
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: markers.archive }],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  const dbPath = resolveOpenClawAgentSqlitePath({ agentId });

  lock = openExclusiveLock(dbPath);
  const blockedOwner = sync({
    reason: "proof-locked-owner",
    sessions: [{ agentId, sessionId: "proof-blocker", sessionKey: blockerKey }],
  });
  const failedQueued = sync({
    reason: "proof-queued-retained",
    sessions: [{ agentId, sessionId: "proof-retained", sessionKey: retainedKey }],
    archiveFiles: [archiveFile],
  });
  const failures = await Promise.allSettled([blockedOwner, failedQueued]);
  const lockedSyncFailures = failures.filter((entry) => entry.status === "rejected").length;
  const sqliteLockFailures = failures.filter(
    (entry) => entry.status === "rejected" && isSqliteLockFailure(entry.reason),
  ).length;
  releaseExclusiveLock(lock);
  lock = null;
  if (lockedSyncFailures !== 2) {
    throw new Error(`expected two locked sync failures, received ${lockedSyncFailures}`);
  }
  if (sqliteLockFailures !== 2) {
    throw new Error(`expected two SQLite lock failures, received ${sqliteLockFailures}`);
  }

  const observer = new DatabaseSync(dbPath, { readOnly: true });
  const retainedBefore =
    (
      observer
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE text LIKE ?")
        .get(`%${markers.retained}%`) as { count: number }
    ).count > 0;
  const triggerBefore =
    (
      observer
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE text LIKE ?")
        .get(`%${markers.trigger}%`) as { count: number }
    ).count > 0;
  const archiveBefore =
    (
      observer
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE text LIKE ?")
        .get(`%${markers.archive}%`) as { count: number }
    ).count > 0;
  observer.close();
  if (retainedBefore || triggerBefore || archiveBefore) {
    throw new Error("a recovery target was unexpectedly indexed before the idle trigger");
  }

  const recoveryState = manager as unknown as {
    syncing: Promise<void> | null;
    queuedArchiveFiles: Set<string>;
    queuedSessions: Map<string, unknown>;
    sessionsDirtyFiles: Set<string>;
    sessionsFullRetryDirty: boolean;
  };
  const retainedQueueBeforeRecovery = recoveryState.queuedSessions.size;
  const retainedArchiveQueueBeforeRecovery = recoveryState.queuedArchiveFiles.size;
  const dirtySessionFilesBeforeRecovery = recoveryState.sessionsDirtyFiles.size;
  const fullRetryBeforeRecovery = recoveryState.sessionsFullRetryDirty;
  if (
    recoveryState.syncing !== null ||
    retainedQueueBeforeRecovery !== 1 ||
    retainedArchiveQueueBeforeRecovery !== 1
  ) {
    throw new Error("manager was not idle with exactly one retained session and archive target");
  }

  const recoveryProgress: Array<{ completed: number; total: number; label?: string }> = [];
  const recovery = sync({
    reason: "proof-idle-recovery-trigger",
    sessions: [{ agentId, sessionId: "proof-trigger", sessionKey: triggerKey }],
    progress: (update) => recoveryProgress.push(update),
  });
  // Start an untargeted sync before the retained queue owner resumes.
  // Its distinct public progress callback proves that this call, rather than
  // an implementation token, reached competing production admission.
  const competingUntargetedProgress: Array<{ completed: number; total: number; label?: string }> =
    [];
  const competingUntargetedSync = sync({
    reason: "proof-competing-untargeted-sync",
    progress: (update) => competingUntargetedProgress.push(update),
  });
  const queueSettlementTimeoutMs = 15_000;
  const recoveryResults = await withTimeout(
    Promise.allSettled([recovery, competingUntargetedSync]),
    queueSettlementTimeoutMs,
    "queue-owner self-deadlock check",
  );
  const recoveryStatus = recoveryResults[0]?.status;
  const competingUntargetedStatus = recoveryResults[1]?.status;
  if (recoveryStatus !== "fulfilled" || competingUntargetedStatus !== "fulfilled") {
    throw new Error(
      `concurrent recovery did not settle: recovery=${recoveryStatus ?? "missing"} untargeted=${competingUntargetedStatus ?? "missing"}`,
    );
  }
  if (competingUntargetedProgress.length === 0) {
    throw new Error("competing untargeted sync emitted no public progress updates");
  }

  const recoveryObserver = new DatabaseSync(dbPath, { readOnly: true });
  const indexedCount = (marker: string) =>
    (
      recoveryObserver
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE text LIKE ?")
        .get(`%${marker}%`) as { count: number }
    ).count;
  const retainedAfter = indexedCount(markers.retained) > 0;
  const triggerAfter = indexedCount(markers.trigger) > 0;
  const archiveAfter = indexedCount(markers.archive) > 0;
  recoveryObserver.close();
  if (!retainedAfter || !triggerAfter || !archiveAfter) {
    throw new Error(
      `recovery result mismatch: retained=${String(retainedAfter)} trigger=${String(triggerAfter)} archive=${String(archiveAfter)}`,
    );
  }
  if (recoveryProgress.length === 0) {
    throw new Error("idle recovery trigger did not receive progress");
  }
  const retainedQueueAfterRecovery = recoveryState.queuedSessions.size;
  const retainedArchiveQueueAfterRecovery = recoveryState.queuedArchiveFiles.size;
  if (
    dirtySessionFilesBeforeRecovery !== 0 ||
    fullRetryBeforeRecovery ||
    retainedQueueAfterRecovery !== 0 ||
    retainedArchiveQueueAfterRecovery !== 0
  ) {
    throw new Error(
      `unexpected recovery ownership state: dirty=${dirtySessionFilesBeforeRecovery} fullRetry=${String(fullRetryBeforeRecovery)} retainedAfter=${retainedQueueAfterRecovery} archiveAfter=${retainedArchiveQueueAfterRecovery}`,
    );
  }

  console.log(`exact_head=${exactHead}`);
  console.log("test_runner=none");
  console.log("entrypoint=MemoryIndexManager.sync");
  console.log("owners=memory-manager,session-store,sqlite");
  console.log(`locked_sync_failures=${lockedSyncFailures}`);
  console.log("locked_sync_failure_kind=sqlite-busy");
  console.log("recovery_manager_state=idle");
  console.log("recovery_input_sessions=proof-trigger");
  console.log(`recovery_progress_updates=${recoveryProgress.length}`);
  console.log(`competing_untargeted_sync_progress_updates=${competingUntargetedProgress.length}`);
  console.log(`recovery_sync_status=${recoveryStatus}`);
  console.log(`competing_untargeted_sync_status=${competingUntargetedStatus}`);
  console.log(`queue_settlement_timeout_ms=${queueSettlementTimeoutMs}`);
  console.log(`retained_queue_before_recovery=${retainedQueueBeforeRecovery}`);
  console.log(`retained_archive_queue_before_recovery=${retainedArchiveQueueBeforeRecovery}`);
  console.log(`sessions_dirty_files_before_recovery=${dirtySessionFilesBeforeRecovery}`);
  console.log(`sessions_full_retry_dirty_before_recovery=${String(fullRetryBeforeRecovery)}`);
  console.log("retained_target_before_recovery=absent");
  console.log("retained_archive_target_before_recovery=absent");
  console.log("retained_target_after_recovery=indexed");
  console.log("retained_archive_target_after_recovery=indexed");
  console.log("idle_trigger_after_recovery=indexed");
  console.log(`retained_queue_after_recovery=${retainedQueueAfterRecovery}`);
  console.log(`retained_archive_queue_after_recovery=${retainedArchiveQueueAfterRecovery}`);
  console.log("verdict=pass");
} finally {
  releaseExclusiveLock(lock);
  await closeAllMemorySearchManagers();
}

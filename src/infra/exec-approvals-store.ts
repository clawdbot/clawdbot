// Loads, updates, restores, and initializes exec approval policy state.
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
  isAgentDeletionBlocked,
} from "../agents/agent-lifecycle-registry.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  createFailClosedExecApprovalsFallback,
  generateToken,
  normalizeExecApprovalsInternal,
  resolveExecApprovalsPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import {
  hardenUnchangedExecApprovals,
  hashExecApprovalsFile,
  readExecApprovalsSnapshotFromPath,
  UnsafeExecApprovalsPathError,
  writeExecApprovalsRaw,
} from "./exec-approvals-file-io.js";
import {
  withExecApprovalsLock,
  withExecApprovalsLockSync,
  withExecApprovalsReadLock,
  withExecApprovalsReadLockSync,
} from "./exec-approvals-lock.js";

function readExecApprovalsSnapshotUnlocked(): ExecApprovalsSnapshot {
  const filePath = resolveExecApprovalsPath();
  return readExecApprovalsSnapshotFromPath(filePath);
}

export function readExecApprovalsSnapshot(): ExecApprovalsSnapshot {
  // Windows' overwrite fallback updates the destination inode in place. Readers
  // must share its lock so they observe either the old policy or the new one.
  return withExecApprovalsReadLockSync(
    resolveExecApprovalsPath(),
    readExecApprovalsSnapshotUnlocked,
  );
}

function loadExecApprovalsUnlocked(): ExecApprovalsFile {
  const filePath = resolveExecApprovalsPath();
  try {
    return readExecApprovalsSnapshotFromPath(filePath).file;
  } catch {
    return createFailClosedExecApprovalsFallback();
  }
}

function loadExecApprovalsHeldByCurrentProcess(): ExecApprovalsFile {
  // The sync lock fails instantly when a same-process async holder owns it —
  // spinning would deadlock the event loop. That failure must not degrade a
  // valid persisted policy to the fail-closed deny fallback: all approvals
  // mutations go through the fully synchronous writeExecApprovalsRaw /
  // hardenUnchangedExecApprovals (no fs.promises anywhere in this store), so
  // while this sync code runs no same-process write can be in flight — the
  // file on disk IS the current committed policy. A missing file stays deny —
  // the holder may be committing the first policy.
  try {
    const snapshot = readExecApprovalsSnapshotFromPath(resolveExecApprovalsPath());
    if (snapshot.exists) {
      return snapshot.file;
    }
  } catch {
    // Unreadable state keeps the fail-closed fallback below.
  }
  return createFailClosedExecApprovalsFallback();
}

export function loadExecApprovals(): ExecApprovalsFile {
  try {
    return withExecApprovalsReadLockSync(resolveExecApprovalsPath(), loadExecApprovalsUnlocked);
  } catch (err) {
    // Cross-process contention stays fail-closed: a foreign writer may be
    // mid-revocation, and deny is the only state we can assert. Only the
    // provably race-free same-process case reads the committed file.
    if ((err as { heldByCurrentProcess?: boolean }).heldByCurrentProcess === true) {
      return loadExecApprovalsHeldByCurrentProcess();
    }
    return createFailClosedExecApprovalsFallback();
  }
}

export async function loadExecApprovalsAsync(): Promise<ExecApprovalsFile> {
  try {
    return await withExecApprovalsReadLock(resolveExecApprovalsPath(), async () =>
      loadExecApprovalsUnlocked(),
    );
  } catch {
    // Match the synchronous reader's fail-closed contract; the async lock
    // already waits for same-process holders via the process-local queue.
    return createFailClosedExecApprovalsFallback();
  }
}

function saveExecApprovalsUnlocked(file: ExecApprovalsFile): void {
  const filePath = resolveExecApprovalsPath();
  const raw = `${JSON.stringify(file, null, 2)}\n`;
  writeExecApprovalsRaw(filePath, raw);
}

type ExecApprovalsUpdate = {
  baseHash?: string;
  update: (file: ExecApprovalsFile) => ExecApprovalsFile | null;
};

export function replaceExecApprovalsSnapshot(
  target: ExecApprovalsFile,
  source: ExecApprovalsFile,
): void {
  target.version = source.version;
  if (source.socket === undefined) {
    delete target.socket;
  } else {
    target.socket = source.socket;
  }
  if (source.defaults === undefined) {
    delete target.defaults;
  } else {
    target.defaults = source.defaults;
  }
  if (source.agents === undefined) {
    delete target.agents;
  } else {
    target.agents = source.agents;
  }
}

type InternalExecApprovalsUpdate = ExecApprovalsUpdate & {
  allowDeletedAgentRemoval?: string;
};

function assertNoDeletedAgentApprovalChanged(
  current: ExecApprovalsFile,
  next: ExecApprovalsFile,
  allowDeletedAgentRemoval?: string,
): void {
  const agentIds = new Set([
    ...Object.keys(current.agents ?? {}),
    ...Object.keys(next.agents ?? {}),
  ]);
  for (const agentId of agentIds) {
    const currentPolicy = current.agents?.[agentId];
    const nextPolicy = next.agents?.[agentId];
    const allowedRemoval =
      agentId === allowDeletedAgentRemoval &&
      currentPolicy !== undefined &&
      nextPolicy === undefined;
    if (
      isAgentDeletionBlocked(agentId) &&
      !allowedRemoval &&
      !isDeepStrictEqual(currentPolicy, nextPolicy)
    ) {
      throw new Error(`Exec approvals are unavailable while agent ${agentId} is deleted.`);
    }
  }
}

function updateExecApprovalsUnlocked(
  params: InternalExecApprovalsUpdate,
): ExecApprovalsSnapshot | null {
  // Both sync and async entry points hold the sidecar lock across this full CAS transaction.
  const current = readExecApprovalsSnapshotUnlocked();
  if (params.baseHash !== undefined && current.hash !== params.baseHash) {
    return null;
  }
  const next = params.update(structuredClone(current.file));
  if (next === null) {
    return current;
  }
  assertNoDeletedAgentApprovalChanged(current.file, next, params.allowDeletedAgentRemoval);
  if (
    current.exists &&
    current.hash === hashExecApprovalsFile(next) &&
    hardenUnchangedExecApprovals(current.path)
  ) {
    return current;
  }
  saveExecApprovalsUnlocked(next);
  return readExecApprovalsSnapshotUnlocked();
}

export function updateExecApprovalsSync(params: ExecApprovalsUpdate): ExecApprovalsSnapshot | null {
  return withExecApprovalsLockSync(() => updateExecApprovalsUnlocked(params));
}

export function saveExecApprovals(file: ExecApprovalsFile): void {
  updateExecApprovalsSync({ update: () => file });
}

export async function updateExecApprovals(
  params: ExecApprovalsUpdate,
): Promise<ExecApprovalsSnapshot | null> {
  return await withExecApprovalsLock(async () => updateExecApprovalsUnlocked(params));
}

/** Hold the approvals lock across an agent deletion and restore policy if commit fails. */
export async function withAgentExecApprovalsRemoved<T>(
  agentId: string,
  commit: () => Promise<T>,
): Promise<T> {
  const key = normalizeAgentId(agentId);
  return await withExecApprovalsLock(async () => {
    const snapshot = readExecApprovalsSnapshotUnlocked();
    try {
      if (Object.hasOwn(snapshot.file.agents ?? {}, key)) {
        const agents = { ...snapshot.file.agents };
        delete agents[key];
        const updated = updateExecApprovalsUnlocked({
          baseHash: snapshot.hash,
          allowDeletedAgentRemoval: key,
          update: (file) => ({ ...file, agents }),
        });
        if (!updated) {
          throw new Error("Exec approvals changed while deleting agent; retry deletion.");
        }
      }
      return await commit();
    } catch (error) {
      if (error instanceof AgentDeletionCommitUncertainError) {
        throw error;
      }
      try {
        restoreExecApprovalsSnapshotUnlocked(snapshot);
      } catch (rollbackError) {
        throw new AgentDeletionAuthorityRollbackError(
          [error, rollbackError],
          `Failed to roll back exec approvals deletion for agent ${key}.`,
          { cause: error },
        );
      }
      throw error;
    }
  });
}

function restoreExecApprovalsSnapshotUnlocked(snapshot: ExecApprovalsSnapshot): void {
  if (!snapshot.exists) {
    fs.rmSync(snapshot.path, { force: true });
  } else if (snapshot.raw !== null) {
    writeExecApprovalsRaw(snapshot.path, snapshot.raw);
  } else {
    saveExecApprovalsUnlocked(snapshot.file);
  }
}

export function restoreExecApprovalsSnapshot(snapshot: ExecApprovalsSnapshot): void {
  withExecApprovalsLockSync(() => restoreExecApprovalsSnapshotUnlocked(snapshot));
}

export async function restoreExecApprovalsSnapshotLocked(
  snapshot: ExecApprovalsSnapshot,
  baseHash: string,
): Promise<boolean> {
  return await withExecApprovalsLock(async () => {
    if (readExecApprovalsSnapshotUnlocked().hash !== baseHash) {
      return false;
    }
    restoreExecApprovalsSnapshotUnlocked(snapshot);
    return true;
  });
}

function ensureExecApprovalsSocket(file: ExecApprovalsFile): ExecApprovalsFile {
  const next = normalizeExecApprovalsInternal(file);
  const socketPath = next.socket?.path?.trim();
  const token = next.socket?.token?.trim();
  return {
    ...next,
    socket: {
      path: socketPath || resolveExecApprovalsSocketPath(),
      token: token || generateToken(),
    },
  };
}

function requireInitializedExecApprovals(
  snapshot: ExecApprovalsSnapshot | null,
): ExecApprovalsSnapshot {
  if (!snapshot) {
    throw new Error("Failed to initialize exec approvals");
  }
  return snapshot;
}

export async function ensureExecApprovalsSnapshot(): Promise<ExecApprovalsSnapshot> {
  return requireInitializedExecApprovals(
    await updateExecApprovals({ update: ensureExecApprovalsSocket }),
  );
}

export function ensureExecApprovals(): ExecApprovalsFile {
  return requireInitializedExecApprovals(
    updateExecApprovalsSync({ update: ensureExecApprovalsSocket }),
  ).file;
}

export function readExecApprovalsForNoPersistenceUnlocked(filePath: string): ExecApprovalsFile {
  try {
    return readExecApprovalsSnapshotFromPath(filePath).file;
  } catch (err) {
    if (err instanceof UnsafeExecApprovalsPathError) {
      throw err;
    }
    return createFailClosedExecApprovalsFallback();
  }
}

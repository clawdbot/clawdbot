// Loads, updates, restores, and initializes exec approval policy state.
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
} from "../agents/agent-lifecycle-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { formatErrorMessage } from "./errors.js";
import {
  createFailClosedExecApprovalsFallback,
  generateToken,
  normalizeExecApprovalsInternal,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import {
  assertNoPendingLegacyExecApprovals,
  ExecApprovalsMigrationRequiredError,
  resetExecApprovalsMigrationGateForTest,
} from "./exec-approvals-migration-gate.js";
import {
  assertExecApprovalsMutationAllowed,
  assertExecApprovalsMutationAuthority,
  deleteExecApprovalsConfigRow,
  ExecApprovalsMutationFencedError,
  type ExecApprovalsMutationAuthority,
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";

const log = createSubsystemLogger("infra/exec-approvals");
const WARN_INTERVAL_MS = 60_000;
let lastWarnAt: number | undefined;

class ExecApprovalsStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Exec approvals SQLite state is unavailable: ${String(cause)}`, { cause });
    this.name = "ExecApprovalsStoreUnavailableError";
  }
}

function warnFailClosed(message: string, error?: unknown): void {
  const now = Date.now();
  if (lastWarnAt !== undefined && now - lastWarnAt < WARN_INTERVAL_MS) {
    return;
  }
  lastWarnAt = now;
  if (error === undefined) {
    log.warn(message);
  } else {
    log.warn(message, { error: formatErrorMessage(error) });
  }
}

function snapshotFromExecApprovalsDatabase(
  db: ReturnType<typeof openOpenClawStateDatabase>["db"],
): ExecApprovalsSnapshot {
  return snapshotFromExecApprovalsRow({
    path: resolveExecApprovalsDisplayPath(),
    row: readExecApprovalsConfigRow(db),
    onMalformed: () =>
      warnFailClosed("exec approvals SQLite row is malformed; denying host execution"),
  });
}

function readExecApprovalsSnapshotFromDatabase(): ExecApprovalsSnapshot {
  assertNoPendingLegacyExecApprovals();
  return snapshotFromExecApprovalsDatabase(openOpenClawStateDatabase().db);
}

function readExecApprovalsSnapshotFromDatabaseReadOnly(): ExecApprovalsSnapshot {
  assertNoPendingLegacyExecApprovals();
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => snapshotFromExecApprovalsDatabase(db)) ??
    snapshotFromExecApprovalsRow({
      path: resolveExecApprovalsDisplayPath(),
      row: undefined,
    })
  );
}

export function readExecApprovalsSnapshot(): ExecApprovalsSnapshot {
  try {
    return readExecApprovalsSnapshotFromDatabase();
  } catch (error) {
    if (error instanceof ExecApprovalsMigrationRequiredError) {
      throw error;
    }
    throw new ExecApprovalsStoreUnavailableError(error);
  }
}

export function loadExecApprovals(): ExecApprovalsFile {
  try {
    return readExecApprovalsSnapshot().file;
  } catch (error) {
    if (!(error instanceof ExecApprovalsStoreUnavailableError)) {
      throw error;
    }
    warnFailClosed("exec approvals SQLite state is unavailable; denying host execution", error);
    return createFailClosedExecApprovalsFallback();
  }
}

/** Loads exec approvals without creating or migrating shared state. */
export function loadExecApprovalsReadOnly(): ExecApprovalsFile {
  try {
    return readExecApprovalsSnapshotFromDatabaseReadOnly().file;
  } catch (error) {
    if (error instanceof ExecApprovalsMigrationRequiredError) {
      throw error;
    }
    warnFailClosed("exec approvals SQLite state is unavailable; denying host execution", error);
    return createFailClosedExecApprovalsFallback();
  }
}

export async function loadExecApprovalsAsync(): Promise<ExecApprovalsFile> {
  return loadExecApprovals();
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
  authority?: ExecApprovalsMutationAuthority;
};

function updateExecApprovalsInTransaction(
  params: InternalExecApprovalsUpdate,
): ExecApprovalsSnapshot | null {
  assertNoPendingLegacyExecApprovals();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = snapshotFromExecApprovalsRow({
        path: resolveExecApprovalsDisplayPath(),
        row: readExecApprovalsConfigRow(db),
        onMalformed: () =>
          warnFailClosed("exec approvals SQLite row is malformed; denying host execution"),
      });
      if (params.baseHash !== undefined && current.hash !== params.baseHash) {
        return null;
      }
      const next = params.update(structuredClone(current.file));
      if (next === null) {
        return current;
      }
      assertExecApprovalsMutationAllowed({
        db,
        current: current.file,
        next,
        authority: params.authority,
      });
      const raw = serializeExecApprovals(next);
      if (current.exists && current.raw === raw) {
        return current;
      }
      writeExecApprovalsConfigRow({ db, file: next, raw });
      return snapshotFromExecApprovalsRow({
        path: current.path,
        row: { raw_json: raw },
      });
    },
    {},
    { operationLabel: "exec-approvals.update" },
  );
}

export function updateExecApprovalsSync(params: ExecApprovalsUpdate): ExecApprovalsSnapshot | null {
  return updateExecApprovalsInTransaction(params);
}

export function saveExecApprovals(file: ExecApprovalsFile): void {
  updateExecApprovalsSync({ update: () => file });
}

export async function updateExecApprovals(
  params: ExecApprovalsUpdate,
): Promise<ExecApprovalsSnapshot | null> {
  return updateExecApprovalsInTransaction(params);
}

/** Remove one deleted agent's policy aliases, restoring them if commit fails. */
export async function withAgentExecApprovalsRemoved<T>(
  agentId: string,
  commit: () => Promise<T>,
): Promise<T> {
  const key = normalizeAgentId(agentId);
  const snapshot = readExecApprovalsSnapshot();
  const operationId = readAgentDeletionJournal(key)?.operationId;
  if (!operationId) {
    throw new ExecApprovalsMutationFencedError();
  }
  const removedPolicyEntries = Object.entries(snapshot.file.agents ?? {}).filter(([policyKey]) => {
    const normalizedPolicyKey = normalizeAgentIdStrict(policyKey);
    return normalizedPolicyKey.ok && normalizedPolicyKey.value === key;
  });
  if (removedPolicyEntries.length > 0) {
    const updated = updateExecApprovalsInTransaction({
      baseHash: snapshot.hash,
      authority: { action: "remove", agentId: key, operationId },
      update: (file) => {
        const agents = { ...file.agents };
        for (const [policyKey] of removedPolicyEntries) {
          delete agents[policyKey];
        }
        return { ...file, agents };
      },
    });
    if (!updated) {
      throw new Error("Exec approvals changed while deleting agent; retry deletion.");
    }
  } else {
    runOpenClawStateWriteTransaction(({ db }) => {
      assertExecApprovalsMutationAuthority(db, {
        action: "remove",
        agentId: key,
        operationId,
      });
    });
  }
  try {
    return await commit();
  } catch (error) {
    if (error instanceof AgentDeletionCommitUncertainError) {
      throw error;
    }
    if (removedPolicyEntries.length > 0) {
      try {
        updateExecApprovalsInTransaction({
          authority: { action: "restore", agentId: key, operationId },
          update: (file) => ({
            ...file,
            agents: { ...file.agents, ...Object.fromEntries(removedPolicyEntries) },
          }),
        });
      } catch (rollbackError) {
        throw new AgentDeletionAuthorityRollbackError(
          [error, rollbackError],
          `Failed to roll back exec approvals deletion for agent ${key}.`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function restoreExecApprovalsSnapshotInTransaction(snapshot: ExecApprovalsSnapshot): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = snapshotFromExecApprovalsRow({
        path: resolveExecApprovalsDisplayPath(),
        row: readExecApprovalsConfigRow(db),
      });
      assertExecApprovalsMutationAllowed({ db, current: current.file, next: snapshot.file });
      if (!snapshot.exists) {
        deleteExecApprovalsConfigRow(db);
        return;
      }
      const raw = snapshot.raw ?? serializeExecApprovals(snapshot.file);
      writeExecApprovalsConfigRow({ db, file: snapshot.file, raw });
    },
    {},
    { operationLabel: "exec-approvals.restore" },
  );
}

export function restoreExecApprovalsSnapshot(snapshot: ExecApprovalsSnapshot): void {
  assertNoPendingLegacyExecApprovals();
  restoreExecApprovalsSnapshotInTransaction(snapshot);
}

export async function restoreExecApprovalsSnapshotLocked(
  snapshot: ExecApprovalsSnapshot,
  baseHash: string,
): Promise<boolean> {
  assertNoPendingLegacyExecApprovals();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = snapshotFromExecApprovalsRow({
        path: resolveExecApprovalsDisplayPath(),
        row: readExecApprovalsConfigRow(db),
      });
      if (current.hash !== baseHash) {
        return false;
      }
      assertExecApprovalsMutationAllowed({ db, current: current.file, next: snapshot.file });
      if (!snapshot.exists) {
        deleteExecApprovalsConfigRow(db);
      } else {
        const raw = snapshot.raw ?? serializeExecApprovals(snapshot.file);
        writeExecApprovalsConfigRow({ db, file: snapshot.file, raw });
      }
      return true;
    },
    {},
    { operationLabel: "exec-approvals.restore-cas" },
  );
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
    updateExecApprovalsInTransaction({ update: ensureExecApprovalsSocket }),
  );
}

export function ensureExecApprovals(): ExecApprovalsFile {
  return requireInitializedExecApprovals(
    updateExecApprovalsInTransaction({ update: ensureExecApprovalsSocket }),
  ).file;
}

const testing = {
  reset(): void {
    resetExecApprovalsMigrationGateForTest();
    lastWarnAt = undefined;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.execApprovalsStoreTestApi")] =
    testing;
}

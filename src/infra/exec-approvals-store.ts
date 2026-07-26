// Loads, updates, restores, and initializes exec approval policy state.
import { isDeepStrictEqual } from "node:util";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
  isAgentDeletionBlocked,
} from "../agents/agent-lifecycle-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { OpenClawStateLeaseError, withOpenClawStateLease } from "../state/openclaw-state-lease.js";
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
  EXEC_APPROVALS_MUTATION_LEASE_KEY,
  EXEC_APPROVALS_MUTATION_LEASE_SCOPE,
  deleteExecApprovalsConfigRow,
  type ExecApprovalsMutationLeaseOwner,
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";

const log = createSubsystemLogger("infra/exec-approvals");
const WARN_INTERVAL_MS = 60_000;
const EXEC_APPROVALS_DELETION_LEASE_MS = 120_000;
const EXEC_APPROVALS_DELETION_LEASE_WAIT_MS = 10_000;
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

function readExecApprovalsSnapshotFromDatabase(): ExecApprovalsSnapshot {
  assertNoPendingLegacyExecApprovals();
  const { db } = openOpenClawStateDatabase();
  return snapshotFromExecApprovalsRow({
    path: resolveExecApprovalsDisplayPath(),
    row: readExecApprovalsConfigRow(db),
    onMalformed: () =>
      warnFailClosed("exec approvals SQLite row is malformed; denying host execution"),
  });
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
  allowDeletedAgentRemoval?: string;
  allowDeletedAgentRestore?: string;
  leaseOwner?: ExecApprovalsMutationLeaseOwner;
};

function assertNoDeletedAgentApprovalChanged(
  current: ExecApprovalsFile,
  next: ExecApprovalsFile,
  params: Pick<
    InternalExecApprovalsUpdate,
    "allowDeletedAgentRemoval" | "allowDeletedAgentRestore"
  >,
): void {
  const agentIds = new Set([
    ...Object.keys(current.agents ?? {}),
    ...Object.keys(next.agents ?? {}),
  ]);
  for (const agentId of agentIds) {
    const currentPolicy = current.agents?.[agentId];
    const nextPolicy = next.agents?.[agentId];
    const allowedRemoval =
      agentId === params.allowDeletedAgentRemoval &&
      currentPolicy !== undefined &&
      nextPolicy === undefined;
    const allowedRestore =
      agentId === params.allowDeletedAgentRestore &&
      currentPolicy === undefined &&
      nextPolicy !== undefined;
    if (
      isAgentDeletionBlocked(agentId) &&
      !allowedRemoval &&
      !allowedRestore &&
      !isDeepStrictEqual(currentPolicy, nextPolicy)
    ) {
      throw new Error(`Exec approvals are unavailable while agent ${agentId} is deleted.`);
    }
  }
}

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
      assertNoDeletedAgentApprovalChanged(current.file, next, params);
      const raw = serializeExecApprovals(next);
      if (current.exists && current.raw === raw) {
        return current;
      }
      writeExecApprovalsConfigRow({ db, file: next, raw, leaseOwner: params.leaseOwner });
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

/** Remove one deleted agent's policy, restoring only that entry if commit fails. */
export async function withAgentExecApprovalsRemoved<T>(
  agentId: string,
  commit: () => Promise<T>,
): Promise<T> {
  const key = normalizeAgentId(agentId);
  try {
    return await withOpenClawStateLease(
      {
        scope: EXEC_APPROVALS_MUTATION_LEASE_SCOPE,
        key: EXEC_APPROVALS_MUTATION_LEASE_KEY,
        database: { scope: "shared" },
        leaseMs: EXEC_APPROVALS_DELETION_LEASE_MS,
        waitMs: EXEC_APPROVALS_DELETION_LEASE_WAIT_MS,
        leaseLabel: "exec approvals agent deletion lease",
        operationLabel: "exec-approvals.agent-deletion.lease",
      },
      async (leaseOwner) => {
        // Heartbeats retain the fence during a slow roster commit. If this process
        // crashes, the persisted TTL expires and writers can proceed without cleanup.
        const snapshot = readExecApprovalsSnapshot();
        const removedPolicy = snapshot.file.agents?.[key];
        if (removedPolicy !== undefined) {
          const updated = updateExecApprovalsInTransaction({
            baseHash: snapshot.hash,
            allowDeletedAgentRemoval: key,
            leaseOwner,
            update: (file) => {
              const agents = { ...file.agents };
              delete agents[key];
              return { ...file, agents };
            },
          });
          if (!updated) {
            throw new Error("Exec approvals changed while deleting agent; retry deletion.");
          }
        }
        try {
          return await commit();
        } catch (error) {
          if (error instanceof AgentDeletionCommitUncertainError) {
            throw error;
          }
          if (removedPolicy !== undefined) {
            try {
              updateExecApprovalsInTransaction({
                allowDeletedAgentRestore: key,
                leaseOwner,
                update: (file) => ({
                  ...file,
                  agents: { ...file.agents, [key]: removedPolicy },
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
      },
    );
  } catch (error) {
    if (
      error instanceof OpenClawStateLeaseError &&
      error.code === "OPENCLAW_STATE_LEASE_STORAGE_FAILED"
    ) {
      throw new ExecApprovalsStoreUnavailableError(error);
    }
    throw error;
  }
}

function restoreExecApprovalsSnapshotInTransaction(
  snapshot: ExecApprovalsSnapshot,
  leaseOwner?: ExecApprovalsMutationLeaseOwner,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (!snapshot.exists) {
        deleteExecApprovalsConfigRow(db, leaseOwner);
        return;
      }
      const raw = snapshot.raw ?? serializeExecApprovals(snapshot.file);
      writeExecApprovalsConfigRow({ db, file: snapshot.file, raw, leaseOwner });
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

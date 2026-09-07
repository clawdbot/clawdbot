import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createAgentDeletionDatabaseCleanup } from "../state/agent-deletion-cleanup.js";
import {
  beginAgentDeletionJournal,
  claimCompletedAgentDeletionJournal,
  completeAgentDeletionJournal,
  readAgentDeletionJournal,
  removeAgentDeletionJournal,
  updateAgentDeletionJournalDatabasePaths,
  updateAgentDeletionJournalCleanupPaths,
  type AgentDeletionJournalCleanupPath,
  type AgentDeletionJournalEntry,
} from "../state/agent-deletion-journal.js";
import { readAgentProvenance, type AgentProvenance } from "../state/agent-provenance.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../state/openclaw-agent-db-lease.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

export class AgentDeletionAuthorityRollbackError extends AggregateError {}

export class AgentDeletionCommitUncertainError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export type AgentLifecycleBinding = Readonly<{
  agentId: string;
  provenance: AgentProvenance | null;
}>;

/** Fence authority producers while an agent deletion is pending or committed. */
export function beginAgentDeletion(
  entry: Omit<
    AgentDeletionJournalEntry,
    | "createdAt"
    | "operationId"
    | "cleanupCompleted"
    | "databasePaths"
    | "cleanupPaths"
    | "deleteFiles"
  > & {
    databasePaths?: string[];
    cleanupPaths?: AgentDeletionJournalCleanupPath[];
    deleteFiles?: boolean;
  },
  options: OpenClawStateDatabaseOptions = {},
): {
  entry: AgentDeletionJournalEntry;
  fenceDatabasePaths: (paths: readonly string[]) => void;
  fenceCleanupPaths: (paths: readonly AgentDeletionJournalCleanupPath[]) => void;
  finish: () => void;
  rollback: () => void;
  runDatabaseCleanup: ReturnType<typeof createAgentDeletionDatabaseCleanup>;
} {
  const id = normalizeAgentId(entry.agentId);
  const statePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  const stateOptions = { ...options, path: statePath, env: options.env && { ...options.env } };
  const operationId = crypto.randomUUID();
  const journal = beginAgentDeletionJournal(
    { ...entry, agentId: id, operationId, deleteFiles: entry.deleteFiles !== false },
    stateOptions,
  );
  let active = true;
  const assertJournal: Parameters<typeof createAgentDeletionDatabaseCleanup>[0]["assertJournal"] = (
    currentStatePath,
    entries,
  ) => {
    if (
      !active ||
      path.resolve(currentStatePath) !== statePath ||
      !entries.some(
        (current) =>
          current.agentId === id &&
          current.operationId === operationId &&
          !current.cleanupCompleted,
      )
    ) {
      throw new Error(`Agent ${id} deletion no longer owns database cleanup.`);
    }
    return id;
  };
  const runDatabaseCleanup = createAgentDeletionDatabaseCleanup({
    statePath,
    assertAdmission: () => assertNoOpenClawAgentDatabaseLeases(id, stateOptions),
    assertJournal,
    assertCurrent: () => {
      const current = readAgentDeletionJournal(id, stateOptions);
      assertJournal(statePath, current ? [current] : []);
    },
  });
  return {
    entry: journal,
    runDatabaseCleanup,
    fenceDatabasePaths: (paths) => {
      if (!updateAgentDeletionJournalDatabasePaths(id, operationId, paths, stateOptions)) {
        throw new Error(`Failed to fence database cleanup paths for agent ${id}.`);
      }
      journal.databasePaths = [...new Set(paths.map((entryPath) => path.resolve(entryPath)))];
    },
    fenceCleanupPaths: (paths) => {
      if (!updateAgentDeletionJournalCleanupPaths(id, operationId, paths, stateOptions)) {
        throw new Error(`Failed to fence cleanup paths for agent ${id}.`);
      }
      journal.cleanupPaths = [...paths];
    },
    finish: () => {
      try {
        completeAgentDeletionJournal(id, operationId, stateOptions);
      } finally {
        active = false;
      }
    },
    rollback: () => {
      try {
        removeAgentDeletionJournal(id, operationId, stateOptions);
      } finally {
        active = false;
      }
    },
  };
}

/** Atomically claim a completed deletion tombstone for a newly created identity. */
export function claimCompletedAgentDeletion(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return claimCompletedAgentDeletionJournal(normalizeAgentId(agentId), operationId, options);
}

/** Return whether this process must refuse new authority for an agent id. */
export function isAgentDeletionBlocked(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return Boolean(readAgentDeletionJournal(normalizeAgentId(agentId), options));
}

/** Captures the exact durable incarnation of an existing, deletion-safe agent. */
export function captureAgentLifecycleBinding(
  config: OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): AgentLifecycleBinding | undefined {
  const id = normalizeAgentId(agentId);
  if (!resolveAgentConfig(config, id) || isAgentDeletionBlocked(id, options)) {
    return undefined;
  }
  return Object.freeze({
    agentId: id,
    provenance: readAgentProvenance(id, options) ?? null,
  });
}

/** Revalidates an agent binding against both the roster and lifecycle owner. */
export function matchesAgentLifecycleBinding(
  config: OpenClawConfig,
  binding: AgentLifecycleBinding,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(binding.agentId);
  return (
    id === binding.agentId &&
    Boolean(resolveAgentConfig(config, id)) &&
    !isAgentDeletionBlocked(id, options) &&
    isDeepStrictEqual(readAgentProvenance(id, options) ?? null, binding.provenance)
  );
}

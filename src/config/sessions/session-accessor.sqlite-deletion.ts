import { AsyncLocalStorage } from "node:async_hooks";
import {
  captureAgentHarnessSessionDeletions,
  type AgentHarnessSessionDeletionTarget,
  type PreparedAgentHarnessSessionDeletion,
} from "../../agents/harness/session-deletion.js";
import type { AgentHarnessSessionDeletionMutation } from "../../agents/harness/types.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-coordinator.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  commitSessionInitializationRollback,
  getSessionInitializationRollback,
  type SessionInitialization,
} from "../../sessions/session-initialization.js";
import {
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { deletePersonalGitHubSessionReceipts } from "../../state/github-personal-publication-lifecycle.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

type DeletionEntry = { sessionKey: string; entry: SessionEntry };
type PreparedDeletion = {
  target: AgentHarnessSessionDeletionTarget;
  mutations: readonly PreparedAgentHarnessSessionDeletion[];
  assertIdle: () => void;
};
const deletions = new AsyncLocalStorage<ReadonlyMap<string, PreparedDeletion>>();
const transactionMutations = new AsyncLocalStorage<{
  rollback: AgentHarnessSessionDeletionMutation[];
  initializations: Set<SessionInitialization>;
}>();

/** Worker commits cannot carry parent-thread native-owner rollback closures. */
export function hasPreparedNativeSessionDeletion(): boolean {
  const prepared = deletions.getStore();
  return (
    prepared !== undefined &&
    [...prepared.values()].some(
      (entry) => entry.mutations.length > 0 || entry.target.initialization !== undefined,
    )
  );
}

type PreparedSessionWrite<T> = {
  deletedEntries: readonly DeletionEntry[];
  beforeCommit?: () => Promise<void>;
  commit: () => T | Promise<T>;
};

/** Keep ordinary updates serialized; release the writer only for native or artifact preparation. */
export async function runPreparedSqliteSessionWrite<T>(
  scope: ResolvedSqliteReadScope,
  prepare: () => Promise<PreparedSessionWrite<T>>,
): Promise<{ deletedEntries: number; result: T }> {
  const prepared = await runExclusiveSqliteSessionWrite(scope, async () => {
    const write = await prepare();
    return write.deletedEntries.length || write.beforeCommit
      ? { write }
      : { result: await write.commit() };
  });
  if (!prepared.write) {
    return { deletedEntries: 0, result: prepared.result };
  }
  const write = prepared.write;
  const result = await withSqliteSessionDeletions(
    scope,
    write.deletedEntries,
    async (assertCurrent) => {
      await write.beforeCommit?.();
      return await runExclusiveSqliteSessionWrite(scope, async () => {
        assertCurrent();
        return await write.commit();
      });
    },
  );
  return { deletedEntries: write.deletedEntries.length, result };
}

/** Prepare owner leases before entering a physical writer or changing any transcript state. */
export async function withSqliteSessionDeletions<T>(
  scope: Pick<
    ResolvedSqliteReadScope,
    "agentId" | "databaseAgentId" | "env" | "ownerStorePath" | "path"
  >,
  entries: readonly DeletionEntry[],
  run: (assertCurrent: () => void) => Promise<T>,
  options: { additionalIdentities?: readonly string[] } = {},
): Promise<T> {
  const targets: AgentHarnessSessionDeletionTarget[] = [
    ...new Map(
      entries
        .filter(({ entry }) => entry.sessionId)
        .map(({ sessionKey, entry }) => [
          sessionKey,
          {
            agentId: parseAgentSessionKey(sessionKey)?.agentId ?? scope.agentId,
            sessionKey,
            sessionId: entry.sessionId,
            ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
            ...(entry.agentHarnessId ? { agentHarnessId: entry.agentHarnessId } : {}),
          },
        ]),
    ).values(),
  ].toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
  const ownerStorePath =
    scope.ownerStorePath ??
    resolveSessionStorePathCore(undefined, { agentId: scope.agentId, env: scope.env });
  for (const target of targets) {
    target.initialization = getSessionInitializationRollback({
      ...target,
      storePath: ownerStorePath,
    });
  }
  const assertTargetIdle = (target: AgentHarnessSessionDeletionTarget) => {
    if (
      isCompetingSessionWorkAdmissionActive(ownerStorePath, [target.sessionKey, target.sessionId])
    ) {
      throw new Error(
        `Cannot delete session while competing work is in flight for ${target.sessionKey}; retry after the run completes`,
      );
    }
  };
  targets.forEach(assertTargetIdle);
  const prepare = captureAgentHarnessSessionDeletions();
  const repositories = createSessionRepositoryWorkspaceStore({
    database: openOpenClawStateDatabase({ env: scope.env }),
  });
  const repositoryWorkspaces = targets.flatMap((target) => {
    const workspace = repositories.find(target);
    return workspace ? [workspace] : [];
  });
  const invoke = async (
    prepared: ReadonlyMap<string, readonly PreparedAgentHarnessSessionDeletion[]>,
  ) => {
    const assertCurrent = () => {
      targets.forEach(assertTargetIdle);
      for (const mutations of prepared.values()) {
        mutations.forEach((mutation) => mutation.assertCurrent());
      }
    };
    assertCurrent();
    return await deletions.run(
      new Map(
        targets.map((target) => [
          target.sessionKey,
          {
            target,
            mutations: prepared.get(target.sessionKey) ?? [],
            assertIdle: () => assertTargetIdle(target),
          },
        ]),
      ),
      async () => {
        try {
          return await run(assertCurrent);
        } finally {
          // Conversation deletion owns repository cleanup, including retained publication
          // sources after a Gateway move. History rotation and failed deletion keep the row.
          for (const workspace of repositoryWorkspaces) {
            const currentEntry = () =>
              readSessionEntryRow(
                openOpenClawAgentDatabase(toDatabaseOptions(scope)),
                workspace.sessionKey,
              );
            if (currentEntry()) {
              continue;
            }
            deletePersonalGitHubSessionReceipts({
              agentId: workspace.agentId,
              env: scope.env,
              sessionKeys: [workspace.sessionKey],
            });
            await repositories.delete({
              workspaceId: workspace.workspaceId,
              assertCurrent: () => {
                if (currentEntry()) {
                  throw new Error("Repository workspace session changed before deletion");
                }
              },
            });
          }
        }
      },
    );
  };
  return await runExclusiveSessionLifecycleMutation({
    scope: ownerStorePath,
    identities: [
      ...targets.flatMap((target) => [target.sessionKey, target.sessionId]),
      ...(options.additionalIdentities ?? []),
    ],
    run: async () => (prepare ? await prepare(targets, invoke) : await invoke(new Map())),
  });
}

/** Called only at the synchronous SQL edge, after the operation revalidates its row snapshot. */
export function commitSqliteSessionDeletion(sessionKey: string, entry: SessionEntry): void {
  const prepared = deletions.getStore()?.get(sessionKey);
  if (!prepared) {
    if (captureAgentHarnessSessionDeletions()) {
      throw new Error(`Session deletion requires prepared harness ownership: ${sessionKey}`);
    }
    return;
  }
  if (
    prepared.target.sessionId !== entry.sessionId ||
    prepared.target.lifecycleRevision !== entry.lifecycleRevision
  ) {
    throw new Error(`Session changed before deletion: ${sessionKey}`);
  }
  prepared.assertIdle();
  const transaction = transactionMutations.getStore();
  if (!transaction) {
    throw new Error(`Session deletion requires its synchronous transaction: ${sessionKey}`);
  }
  for (const mutation of prepared.mutations) {
    transaction.rollback.push(mutation);
    mutation.commit();
  }
  if (prepared.target.initialization) {
    transaction.initializations.add(prepared.target.initialization);
  }
}

/** Roll back companion state only if SQLite failed before COMMIT, never after publication. */
export function runSqliteSessionDeletionTransaction<T>(
  operation: (database: OpenClawAgentDatabase) => T,
  options: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
  transactionOptions?: Parameters<typeof runOpenClawAgentWriteTransaction>[2],
): T {
  if (!deletions.getStore() || transactionMutations.getStore()) {
    return runOpenClawAgentWriteTransaction(operation, options, transactionOptions);
  }
  const rollback: AgentHarnessSessionDeletionMutation[] = [];
  const initializations = new Set<SessionInitialization>();
  let committed = false;
  try {
    return transactionMutations.run({ rollback, initializations }, () =>
      runOpenClawAgentWriteTransaction(
        (database) => {
          deferOpenClawAgentPostCommitPublication(database, () => {
            committed = true;
            initializations.forEach(commitSessionInitializationRollback);
          });
          return operation(database);
        },
        options,
        transactionOptions,
      ),
    );
  } catch (error) {
    const failures = [error];
    if (!committed) {
      for (const mutation of rollback.toReversed()) {
        try {
          mutation.rollback();
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
    }
    if (failures.length > 1) {
      throw createSqliteLifecycleAggregateError(
        failures,
        "Session deletion rollback failed",
        error,
      );
    }
    throw error;
  }
}

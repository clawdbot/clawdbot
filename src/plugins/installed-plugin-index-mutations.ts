import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import type { UpdateCheckpointPluginIndexMutation } from "../infra/update-checkpoint-plugin-index.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type Scope = {
  active: boolean;
  assertCurrent: () => void;
  mutations: UpdateCheckpointPluginIndexMutation[];
};
const current = resolveGlobalSingleton(
  Symbol.for("openclaw.installedPluginIndexMutationScope"),
  () => new AsyncLocalStorage<Scope>(),
);

/** Called by the index writer inside its actual transaction, before any write. */
export function prepareInstalledPluginIndexMutation() {
  const scope = current.getStore();
  if (!scope) {
    return undefined;
  }
  if (!scope.active) {
    throw new Error("Installed plugin mutation ownership has closed");
  }
  scope.assertCurrent();
  return (db: DatabaseSync, mutation: UpdateCheckpointPluginIndexMutation): void => {
    // Recheck before the enclosing synchronous transaction can commit. The
    // post-commit observer remains non-throwing and never supplies authority.
    if (!scope.active) {
      throw new Error("Installed plugin mutation ownership has closed");
    }
    scope.assertCurrent();
    const retained = structuredClone(mutation);
    // The shared transaction owner discards observers on savepoint/outer rollback.
    // Publication itself is non-throwing and never grants write authority.
    if (!deferSqlitePostCommitPublication(db, () => scope.mutations.push(retained))) {
      throw new Error("Installed plugin mutation has no outer commit owner");
    }
  };
}

/** Retain only committed writer receipts while the caller owns plugin/file exclusion.
 * An operation failure is returned with its receipts so partial work can be captured
 * before those real owners are released. Lost authority still throws.
 */
export async function collectInstalledPluginIndexMutations<T>(
  assertCurrent: () => void,
  operation: () => Promise<T>,
): Promise<{
  outcome: { value: T } | { error: unknown };
  mutations: UpdateCheckpointPluginIndexMutation[];
}> {
  if (current.getStore()) {
    throw new Error("Installed plugin mutation collection cannot replace an active owner");
  }
  const scope: Scope = { active: true, assertCurrent, mutations: [] };
  return current.run(scope, async () => {
    let outcome: { value: T } | { error: unknown };
    try {
      assertCurrent();
      try {
        outcome = { value: await operation() };
      } catch (error) {
        outcome = { error };
      }
      assertCurrent();
      return { outcome, mutations: scope.mutations };
    } finally {
      scope.active = false;
    }
  });
}

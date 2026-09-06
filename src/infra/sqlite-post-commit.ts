import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// One connection can cross native and transformed SDK module graphs mid-transaction.
const pendingPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.sqlitePostCommitPublications"),
  () => new WeakMap<DatabaseSync, Array<() => void>>(),
);
const pendingTransactionState = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteTransactionState"),
  () => new WeakMap<DatabaseSync, Array<{ commit: () => void; rollback: () => void }>>(),
);

/** Publications are non-throwing observers, never part of a durable transaction's result. */
export function deferSqlitePostCommitPublication(db: DatabaseSync, publish: () => void): boolean {
  const pending = pendingPublications.get(db);
  if (!pending) {
    return false;
  }
  pending.push(publish);
  return true;
}

/**
 * Stage private transaction-local state that publishes before fallible observers.
 * Stage, rollback, and commit callbacks must not throw.
 */
export function stageSqliteTransactionState(
  db: DatabaseSync,
  state: { stage: () => void; rollback: () => void; commit: () => void },
): boolean {
  const pending = pendingTransactionState.get(db);
  if (!pending) {
    return false;
  }
  state.stage();
  pending.push({ commit: state.commit, rollback: state.rollback });
  return true;
}

/** Nested rollback restores staged state and discards observers; savepoints wait for outer commit. */
export function withSqlitePostCommitPublications<T>(db: DatabaseSync, transaction: () => T): T {
  const nested = db.isTransaction;
  const publications = nested ? pendingPublications.get(db) : [];
  const transactionState = nested ? pendingTransactionState.get(db) : [];
  const publicationStart = publications?.length ?? 0;
  const stateStart = transactionState?.length ?? 0;
  if (!nested && publications && transactionState) {
    pendingPublications.set(db, publications);
    pendingTransactionState.set(db, transactionState);
  }
  let result: T;
  try {
    result = transaction();
  } catch (error) {
    publications?.splice(publicationStart);
    const rolledBackState = transactionState?.splice(stateStart) ?? [];
    for (const state of rolledBackState.toReversed()) {
      state.rollback();
    }
    throw error;
  } finally {
    if (!nested) {
      pendingPublications.delete(db);
      pendingTransactionState.delete(db);
    }
  }
  if (!nested) {
    for (const state of transactionState ?? []) {
      state.commit();
    }
    for (const publish of publications ?? []) {
      publish();
    }
  }
  return result;
}

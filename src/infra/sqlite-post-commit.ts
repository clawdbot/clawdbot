import type { DatabaseSync } from "node:sqlite";

const pendingPublications = new WeakMap<DatabaseSync, Array<() => void>>();

/** Publications are non-throwing observers, never part of a durable transaction's result. */
export function deferSqlitePostCommitPublication(db: DatabaseSync, publish: () => void): boolean {
  const pending = pendingPublications.get(db);
  if (!pending) {
    return false;
  }
  pending.push(publish);
  return true;
}

/** Nested rollback discards its observers; successful savepoints wait for the outer commit. */
export function withSqlitePostCommitPublications<T>(db: DatabaseSync, transaction: () => T): T {
  const nested = db.isTransaction;
  const pending = nested ? pendingPublications.get(db) : [];
  const start = pending?.length ?? 0;
  if (!nested && pending) {
    pendingPublications.set(db, pending);
  }
  let result: T;
  try {
    result = transaction();
  } catch (error) {
    pending?.splice(start);
    throw error;
  } finally {
    if (!nested) {
      pendingPublications.delete(db);
    }
  }
  if (!nested) {
    for (const publish of pending ?? []) {
      publish();
    }
  }
  return result;
}

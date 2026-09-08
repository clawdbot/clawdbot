import fs from "node:fs";
import path from "node:path";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../../infra/node-sqlite.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-coordinator.js";
import { checkpointRetainedSqliteWal } from "../../infra/sqlite-wal.js";
import {
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
} from "../../infra/state-database-coordinator.js";
import { assertSqliteFamilyClosed } from "../../infra/update-checkpoint-plan.js";
import type { ReopenedUpdateCheckpoint } from "../../infra/update-checkpoint.js";

/** SQLite, not filesystem deletion, settles committed WAL under exclusive custody.
 * Caller retains the stopped native owner, shared writer drainage, source locks
 * and executor. This runs only before an unsealed plan captures current state. */
function closeRetainedAgentFamily(file: string, assertCurrent: () => void) {
  assertCurrent();
  const family = ["", "-wal", "-shm", "-journal"].map((suffix) => {
    try {
      const stat = fs.lstatSync(file + suffix);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error("Replay SQLite family requires unaliased regular files");
      }
      return stat;
    } catch (error) {
      if (suffix && hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  });
  if (fs.realpathSync(file) !== file || family[3]) {
    throw new Error("Replay agent family requires a canonical WAL database without a journal");
  }
  if (!family[1] && !family[2]) {
    return;
  }
  const original = family[0];
  if (!original) {
    throw new Error("Replay agent database is missing");
  }
  const verify = () => {
    assertCurrent();
    const current = fs.lstatSync(file);
    if (
      !current.isFile() ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      fs.realpathSync(file) !== file
    ) {
      throw new Error("Replay agent database identity changed during closure");
    }
  };
  verify();
  // mode=rw refuses missing databases. No schema opening, migrations or logical leases.
  const db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(file));
  try {
    checkpointRetainedSqliteWal(db, verify);
  } finally {
    db.close();
  }
  verify();
  assertSqliteFamilyClosed(file);
}

/** Keep physical agent ownership through preparation and publication. Source
 * reads join these owners; unrelated live handles cannot borrow their authority. */
export async function withUpdateCommandAgentPublication<T>(
  params: {
    original: ReopenedUpdateCheckpoint;
    current: ReopenedUpdateCheckpoint;
    assertCurrent: () => void;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const { assertCurrent } = params;
  const stateDir = params.original.manifest.binding.stateDir;
  const files = params.current.manifest.resources
    .filter((resource) => {
      const relative = path
        .relative(path.join(stateDir, "agents"), resource.sourcePath)
        .split(path.sep);
      return (
        resource.kind === "sqlite" &&
        resource.restore === "replace" &&
        resource.artifact &&
        relative.length === 3 &&
        relative[0] !== ".." &&
        relative[1] === "agent" &&
        relative[2] === "openclaw-agent.sqlite" &&
        params.original.manifest.resources.some(
          (old) => old.sourcePath === resource.sourcePath && old.kind === "sqlite" && old.artifact,
        )
      );
    })
    .map((resource) => resource.sourcePath)
    .toSorted();
  const visit = async (index: number): Promise<T> => {
    assertCurrent();
    const file = files[index];
    if (!file) {
      return operation();
    }
    const lifecycle = acquireStateDatabaseCoordinator({ databasePath: file, busyTimeoutMs: 0 });
    let handles: ReturnType<typeof acquireStateDatabaseHandleExclusion> | undefined;
    const errors: unknown[] = [];
    let completed: { result: T } | undefined;
    try {
      const held = acquireStateDatabaseHandleExclusion({ databasePath: file, busyTimeoutMs: 0 });
      handles = held;
      const current = () => {
        assertCurrent();
        held.assertCurrent();
      };
      closeRetainedAgentFamily(file, current);
      completed = { result: await held.runWithSourceReads(() => visit(index + 1)) };
      current();
      handles.assertNoPins();
    } catch (error) {
      errors.push(error);
    } finally {
      for (const owner of [handles, lifecycle]) {
        try {
          owner?.release();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw createSqliteLifecycleAggregateError(
        errors,
        "Agent publication and owner release failed",
        errors[0],
      );
    }
    if (!completed) {
      throw new Error("Agent publication did not complete");
    }
    return completed.result;
  };
  return visit(0);
}

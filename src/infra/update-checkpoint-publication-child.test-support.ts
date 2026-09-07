import fs from "node:fs";
import { acquireOpenClawStateDatabaseFileExclusion } from "../state/openclaw-state-db-cache.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "./node-sqlite.js";
import { acquireStateDatabaseHandleLease } from "./state-database-coordinator.js";
import { restoreUpdateCheckpointResource } from "./update-checkpoint-restore.js";

const [mode, input] = process.argv.slice(2);
if (!input) {
  throw new Error("missing isolated child input");
}
if (mode === "hold") {
  const held = acquireStateDatabaseHandleLease({ databasePath: input });
  const db = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(input), { readOnly: true });
  process.on("message", () => {
    db.close();
    held.release();
    process.disconnect?.();
  });
  process.send?.({ ready: true });
} else if (mode === "displace") {
  // The parent writes this isolated synthetic fixture; runtime entrypoints are not exposed.
  const request = JSON.parse(fs.readFileSync(input, "utf8")) as Parameters<
    typeof restoreUpdateCheckpointResource
  >[0] & { sourcePath: string };
  const owner = acquireOpenClawStateDatabaseFileExclusion(request.sourcePath);
  // Fault injection wraps a REAL rename, then exits without unwinding owners.
  // The OS must release process-held coordinator/SQLite descriptors on death.
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (from === request.sourcePath) {
      process.exit(73);
    }
  };
  try {
    await owner.runWithSourceReads(() =>
      restoreUpdateCheckpointResource({
        ...request,
        assertQuiescent: owner.assertCurrent,
      }),
    );
    throw new Error("publication did not reach displacement");
  } finally {
    owner.release();
  }
} else {
  throw new Error("unknown child mode");
}

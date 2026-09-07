import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "../state/openclaw-state-db-cache.js";
import * as handles from "../state/openclaw-state-db-handle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as sqlite from "./node-sqlite.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "./update-checkpoint.js";
import { hasManagedUpdateRecoveryRecord } from "./update-managed-service-recovery-presence.js";
import { createUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";
import {
  acceptUpdateRecoveryHandoff,
  beginUpdateRecovery,
  claimUpdateRecovery,
  bindUpdateRecoveryCheckpoint,
  recordUpdateRecoveryIntent,
  loadUpdateRecovery,
  prepareUpdateRecoveryHandoff,
} from "./update-run-recovery.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
// These tests own every writer in their disposable state roots.
const fence = { assertCurrent() {} };
function source() {
  const root = dirs.make("openclaw-handoff-before-migration-");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const from = {
    root: path.join(root, "previous"),
    nodePath: process.execPath,
    version: "1.0.0",
    buildId: "old",
  };
  const to = { ...from, root: path.join(root, "candidate"), version: "2.0.0", buildId: "new" };
  const prepared = prepareUpdateRecoveryHandoff(
    beginUpdateRecovery({ runId: run.runId, from, to }, fence, options),
    fence,
    options,
  );
  const pathname = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();
  const legacy = openNodeSqliteDatabase(pathname);
  try {
    // Legitimate v15/no-Workshop shape also covered by the state-owner migration tests.
    legacy.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE IF EXISTS skill_workshop_proposal_events;
      DROP TABLE IF EXISTS skill_workshop_proposal_rollbacks;
      DROP TABLE IF EXISTS skill_workshop_collection_reviews;
      DROP TABLE IF EXISTS skill_workshop_proposals;
      PRAGMA user_version=15;
      UPDATE schema_meta SET schema_version=15 WHERE meta_key='primary';`);
  } finally {
    legacy.close();
  }
  return { root, options, run, to, prepared, pathname };
}
function shape(pathname: string) {
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get(),
      schema: db
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .all(),
      metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    };
  } finally {
    db.close();
  }
}
it("accepts the exact handoff without migrating the previous runtime's state", () => {
  const f = source();
  const before = shape(f.pathname);
  const accepted = acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options);
  closeOpenClawStateDatabaseForTest();
  expect(shape(f.pathname)).toEqual(before);
  expect(accepted.handoff?.state).toBe("accepted");
  expect(accepted.claimId).not.toBe(f.prepared.record.claimId);
  expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(accepted);
  expect(() => acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options)).toThrow();
  expect(shape(f.pathname)).toEqual(before);
});
it("prepares another candidate handoff without migrating an owned previous schema", () => {
  const f = source();
  const accepted = acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options);
  const before = shape(f.pathname);
  const next = prepareUpdateRecoveryHandoff(accepted, fence, f.options);
  closeOpenClawStateDatabaseForTest();
  expect(shape(f.pathname)).toEqual(before);
  expect(next.record.handoff?.state).toBe("prepared");
  expect(next.record.claimId).not.toBe(accepted.claimId);
  expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(next.record);
  expect(() => prepareUpdateRecoveryHandoff(accepted, fence, f.options)).toThrow();
  expect(acceptUpdateRecoveryHandoff(next.handoff, f.to, fence, f.options).handoff?.state).toBe(
    "accepted",
  );
  expect(shape(f.pathname)).toEqual(before);
});
it("records candidate mutation intent before any schema migration", async () => {
  const f = source();
  let record = acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options);
  const configPath = path.join(f.root, "openclaw.json");
  fs.writeFileSync(configPath, "{}");
  const access = {
    artifactRoot: path.join(f.root, "artifacts"),
    binding: {
      runId: record.runId,
      stateDir: f.root,
      configPath,
      fromRuntime: {
        root: record.from.root,
        nodePath: record.from.nodePath,
        version: record.from.version,
      },
    },
  };
  const ref = await captureUpdateCheckpoint({
    ...access,
    assertQuiescent: () => fence.assertCurrent(),
    resources: [{ sourcePath: configPath, kind: "config", restore: "replace" }],
    exclusions: [],
  });
  const checkpoint = await reopenUpdateCheckpoint(ref, access);
  record = bindUpdateRecoveryCheckpoint(
    record,
    { ref: checkpoint.ref, binding: checkpoint.manifest.binding },
    fence,
    f.options,
  );
  closeOpenClawStateDatabaseForTest();
  const previous = openNodeSqliteDatabase(f.pathname);
  try {
    previous.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE IF EXISTS skill_workshop_proposal_events;
      DROP TABLE IF EXISTS skill_workshop_proposal_rollbacks;
      DROP TABLE IF EXISTS skill_workshop_collection_reviews;
      DROP TABLE IF EXISTS skill_workshop_proposals;
      PRAGMA user_version=15;
      UPDATE schema_meta SET schema_version=15 WHERE meta_key='primary';`);
  } finally {
    previous.close();
  }
  const before = shape(f.pathname);
  const next = recordUpdateRecoveryIntent(
    record,
    {
      effectId: randomUUID(),
      kind: "runtime-mutation",
      runtime: "candidate",
      resourceId: "doctor",
    },
    fence,
    f.options,
  );
  closeOpenClawStateDatabaseForTest();
  expect(shape(f.pathname)).toEqual(before);
  expect(loadUpdateRecovery(record.runId, f.options)?.effects).toEqual(next.effects);
  expect(next.effects.at(-1)).toMatchObject({ kind: "runtime-mutation", state: "intent" });
  expect(() => prepareUpdateRecoveryHandoff(next, fence, f.options)).toThrow(/outstanding effects/);
  expect(shape(f.pathname)).toEqual(before);
});
it("refuses candidate writes before checkpoint handoff without migrating state", () => {
  const f = source();
  const record = acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options);
  const before = shape(f.pathname);
  expect(() =>
    recordUpdateRecoveryIntent(
      record,
      {
        effectId: randomUUID(),
        kind: "runtime-mutation",
        runtime: "candidate",
        resourceId: "doctor",
      },
      fence,
      f.options,
    ),
  ).toThrow(/checkpoint handoff/);
  expect(shape(f.pathname)).toEqual(before);
  expect(loadUpdateRecovery(record.runId, f.options)).toEqual(record);
});
it.each(["claim", "runtime", "fence"])(
  "refuses %s mismatch without schema or record mutation",
  (mismatch) => {
    const f = source();
    const before = shape(f.pathname);
    expect(() =>
      acceptUpdateRecoveryHandoff(
        mismatch === "claim"
          ? { ...f.prepared.handoff, claimId: randomUUID() }
          : f.prepared.handoff,
        mismatch === "runtime" ? { ...f.to, buildId: "different" } : f.to,
        mismatch === "fence"
          ? {
              assertCurrent() {
                throw new Error("owner lost");
              },
            }
          : fence,
        f.options,
      ),
    ).toThrow();
    closeOpenClawStateDatabaseForTest();
    expect(shape(f.pathname)).toEqual(before);
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.prepared.record);
  },
);
it("refuses acceptance while another owner excludes the physical state file", () => {
  const f = source();
  const before = fs.readFileSync(f.pathname);
  const held = acquireOpenClawStateDatabaseFileExclusion(f.pathname);
  try {
    expect(() => acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options)).toThrow(
      /state-handles/,
    );
    expect(fs.readFileSync(f.pathname)).toEqual(before);
  } finally {
    held.release();
  }
});

it("does not create a canonical database when a prepared handoff loses its source", () => {
  const f = source();
  fs.renameSync(f.pathname, f.pathname + ".retained");
  expect(() => acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options)).toThrow();
  expect(fs.existsSync(f.pathname)).toBe(false);
  expect(shape(f.pathname + ".retained").version).toEqual({ user_version: 15 });
});
it.each(["future", "metadata", "trigger"])(
  "refuses %s state without consuming a prepared handoff",
  (scenario) => {
    const f = source();
    const raw = openNodeSqliteDatabase(f.pathname);
    try {
      if (scenario === "future") {
        raw.exec(
          "PRAGMA user_version=2147483647; UPDATE schema_meta SET schema_version=2147483647 WHERE meta_key='primary'",
        );
      } else if (scenario === "metadata") {
        raw.exec("UPDATE schema_meta SET schema_version=14 WHERE meta_key='primary'");
      } else {
        raw.exec(
          "CREATE TRIGGER unexpected_recovery_write AFTER UPDATE ON config_machine_state BEGIN UPDATE schema_meta SET app_version='unexpected'; END;",
        );
      }
    } finally {
      raw.close();
    }
    const before = shape(f.pathname);
    expect(() => acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options)).toThrow();
    expect(shape(f.pathname)).toEqual(before);
    const read = openNodeSqliteDatabase(f.pathname, { readOnly: true });
    try {
      const row = read
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key LIKE 'update.recovery.%'",
        )
        .get();
      // Match the exact retained row without opening it through a schema-mutating runtime.
      expect(row).toBeDefined();
      expect(JSON.parse(String(row?.value_json))).toEqual(f.prepared.record);
    } finally {
      read.close();
    }
  },
);
it("rolls back acceptance when live ownership is lost after its write", () => {
  const f = source();
  const before = shape(f.pathname);
  let assertions = 0;
  expect(() =>
    acceptUpdateRecoveryHandoff(
      f.prepared.handoff,
      f.to,
      {
        assertCurrent() {
          if (++assertions === 3) {
            throw new Error("owner lost before commit");
          }
        },
      },
      f.options,
    ),
  ).toThrow("owner lost before commit");
  expect(shape(f.pathname)).toEqual(before);
  expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.prepared.record);
});

it("does not recreate canonical state displaced immediately before the ownership probe", () => {
  const f = source();
  const before = shape(f.pathname);
  const open = sqlite.openNodeSqliteDatabase;
  let displaced = false;
  const spy = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((location, options) => {
    if (
      !displaced &&
      options === undefined &&
      (location === f.pathname || location === `${pathToFileURL(f.pathname).href}?mode=rw`)
    ) {
      displaced = true;
      fs.renameSync(f.pathname, f.pathname + ".retained");
    }
    return open(location, options);
  });
  try {
    expect(() => acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options)).toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(displaced).toBe(true);
  expect(fs.existsSync(f.pathname)).toBe(false);
  expect(shape(f.pathname + ".retained")).toEqual(before);
});

it("does not recreate canonical state displaced immediately before the tracked writer", () => {
  const f = source();
  const before = shape(f.pathname);
  const open = handles.openTrackedStateDatabase;
  const spy = vi
    .spyOn(handles, "openTrackedStateDatabase")
    .mockImplementation((pathname, options) => {
      fs.renameSync(pathname, pathname + ".retained");
      return open(pathname, options);
    });
  try {
    expect(() => acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options)).toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(fs.existsSync(f.pathname)).toBe(false);
  expect(shape(f.pathname + ".retained")).toEqual(before);
});

it("detects WAL-only helper recovery without changing the canonical SQLite family", () => {
  const f = source();
  const db = openNodeSqliteDatabase(f.pathname);
  try {
    const key = `update.recovery.${f.run.runId}`;
    const row = db.prepare("SELECT * FROM config_machine_state WHERE state_key=?").get(key);
    if (typeof row?.value_json !== "string" || typeof row.updated_at_ms !== "number") {
      throw new Error("Expected the prepared recovery row");
    }
    db.prepare("DELETE FROM config_machine_state WHERE state_key=?").run(key);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
    expect(hasManagedUpdateRecoveryRecord(f.pathname, f.run.runId)).toBe(false);
    db.prepare(
      "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES (?,?,?)",
    ).run(key, row.value_json, row.updated_at_ms);
    const family = () =>
      ["", "-wal", "-shm", "-journal"].map((suffix) => {
        const file = f.pathname + suffix;
        return fs.existsSync(file) ? fs.readFileSync(file) : null;
      });
    const before = family();
    expect(before[1]?.length).toBeGreaterThan(0);
    expect(hasManagedUpdateRecoveryRecord(f.pathname, f.run.runId)).toBe(true);
    expect(family()).toEqual(before);
  } finally {
    db.close();
  }
});
it.each(["missing", "metadata", "run", "future"])(
  "does not classify %s helper state as recovery absence",
  (failure) => {
    const f = source();
    if (failure === "missing") {
      fs.renameSync(f.pathname, f.pathname + ".retained");
    } else {
      const db = openNodeSqliteDatabase(f.pathname);
      try {
        if (failure === "metadata") {
          db.exec("UPDATE schema_meta SET schema_version=14 WHERE meta_key='primary'");
        } else if (failure === "run") {
          db.prepare("DELETE FROM update_runs WHERE run_id=?").run(f.run.runId);
        } else {
          db.exec("PRAGMA user_version=2147483647");
        }
      } finally {
        db.close();
      }
    }
    expect(() => hasManagedUpdateRecoveryRecord(f.pathname, f.run.runId)).toThrow();
    if (failure === "missing") {
      expect(fs.existsSync(f.pathname)).toBe(false);
    }
  },
);

it.each(["claim", "ledger", "stale-claim"] as const)(
  "preserves the restored runtime schema during %s bookkeeping",
  (operation) => {
    const f = source();
    const accepted = acceptUpdateRecoveryHandoff(f.prepared.handoff, f.to, fence, f.options);
    const before = shape(f.pathname);
    if (operation === "claim") {
      const next = claimUpdateRecovery(accepted, fence, f.options);
      expect(next.claimKind).toBe("recovery");
      expect(next.claimId).not.toBe(accepted.claimId);
    } else if (operation === "ledger") {
      expect(recordUpdateRunPhase(f.run.runId, "verifying", {}, f.options).phase).toBe("verifying");
    } else {
      expect(() =>
        claimUpdateRecovery({ ...accepted, revision: accepted.revision + 1 }, fence, f.options),
      ).toThrow();
    }
    closeOpenClawStateDatabaseForTest();
    expect(shape(f.pathname)).toEqual(before);
  },
);

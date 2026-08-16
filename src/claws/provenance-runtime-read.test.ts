import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  initializeCachedClawInstallSchemaVersions,
  readCachedClawInstallSchemaVersions,
} from "./provenance-runtime-read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

describe("Claw runtime provenance cache", () => {
  it("treats an absent first-run state database as empty ownership", () => {
    const root = tempDirs.make("openclaw-claw-runtime-provenance-first-run-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };

    initializeCachedClawInstallSchemaVersions(options);

    expect(readCachedClawInstallSchemaVersions(options)).toMatchObject({
      kind: "ready",
      schemaVersions: new Map(),
    });
  });

  it("refreshes install ownership written by another process", () => {
    const root = tempDirs.make("openclaw-claw-runtime-provenance-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    const database = openOpenClawStateDatabase(options);

    initializeCachedClawInstallSchemaVersions(options);
    expect(readCachedClawInstallSchemaVersions(options)).toMatchObject({
      kind: "ready",
      schemaVersions: new Map(),
    });

    const external = new DatabaseSync(database.path);
    try {
      external
        .prepare(
          `INSERT INTO claw_installs (
             agent_id, schema_version, source_kind, claw_name, claw_version,
             package_root, manifest_path, integrity_kind, integrity, source_byte_length,
             manifest_schema_version, plan_integrity, workspace, agent_config_digest,
             agent_owned_paths_json, bootstrap_source_path, bootstrap_content_digest,
             status, added_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          "worker",
          "openclaw.clawInstallRecord.v2",
          "package",
          "@acme/worker",
          "1.0.0",
          root,
          `${root}\\openclaw.claw.json`,
          "artifact",
          "sha256:manifest",
          100,
          1,
          "sha256:plan",
          `${root}\\workspace`,
          "sha256:agent-config",
          '["agents.entries[\\"worker\\"]"]',
          "complete",
          1,
          1,
        );
    } finally {
      external.close();
    }

    initializeCachedClawInstallSchemaVersions(options);
    const refreshed = readCachedClawInstallSchemaVersions(options);
    expect(refreshed.kind).toBe("ready");
    if (refreshed.kind !== "ready") {
      throw new Error("expected ready Claw provenance snapshot");
    }
    expect(refreshed.schemaVersions.get("worker")).toMatchObject({
      kind: "ok",
      schemaVersion: "openclaw.clawInstallRecord.v2",
      agentConfigDigest: "sha256:agent-config",
    });

    closeOpenClawStateDatabaseForTest();
    rmSync(database.path);
    initializeCachedClawInstallSchemaVersions(options);
    expect(readCachedClawInstallSchemaVersions(options)).toMatchObject({
      kind: "state-error",
      knownAgentIds: new Set(["worker"]),
      ownershipUnknown: true,
    });
  });
});

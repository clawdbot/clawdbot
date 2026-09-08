import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createBackupResourceInventory } from "../commands/backup-resource-inventory.js";
import { createConfigIO } from "../config/config.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { sanitizeOpenClawGlobalStateSnapshot } from "../state/openclaw-state-snapshot-sanitizer.js";
import {
  captureUpdateCheckpoint,
  collectUpdateCheckpointResources,
  reopenUpdateCheckpoint,
  type UpdateCheckpointAccess,
} from "./update-checkpoint.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-inventory-")));
  roots.push(root);
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  const access: UpdateCheckpointAccess = {
    artifactRoot: path.join(root, "artifacts"),
    binding: {
      runId: "inventory-test",
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      fromRuntime: {
        root: path.join(root, "package"),
        version: "1.0.0",
        nodePath: process.execPath,
      },
    },
    // This fixture owns every writer and closes all SQLite handles before capture.
    assertQuiescent() {},
  };
  return { root, stateDir, access };
}

describe("checkpoint exact inventory inputs", () => {
  it("captures include-provenance config, external service/env preimages and plugin dependencies despite archive exclusions", async () => {
    const f = await fixture();
    const configDir = path.join(f.root, "config");
    await fs.mkdir(configDir);
    const includePath = path.join(configDir, "gateway.json");
    const configPath = path.join(configDir, "openclaw.json");
    f.access.binding.configPath = configPath;
    await fs.writeFile(includePath, '{"port":18789}\n');
    await fs.writeFile(configPath, JSON.stringify({ gateway: { $include: includePath } }));
    const io = createConfigIO({
      configPath,
      env: {},
      homedir: () => f.root,
      observe: false,
      pluginValidation: "core-only",
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);
    const includes =
      snapshot.includeProvenance?.flatMap(
        (entry) => entry.targetPaths ?? (entry.targetPath ? [entry.targetPath] : []),
      ) ?? [];
    expect(includes).toEqual([includePath]);
    const service = path.join(f.root, "gateway.service");
    const serviceEnv = path.join(f.root, "gateway.env");
    const absentEnv = path.join(f.root, "optional.env");
    await fs.writeFile(service, "[Service]\nEnvironmentFile=gateway.env\n");
    await fs.writeFile(serviceEnv, "OPERATOR_LABEL=before\n");
    const pluginRoot = path.join(f.stateDir, "plugins", "fixture");
    const dependency = path.join(pluginRoot, "node_modules", "dependency", "index.js");
    await fs.mkdir(path.dirname(dependency), { recursive: true });
    await fs.writeFile(dependency, "export const version = 1;\n");
    const inventory = await createBackupResourceInventory({
      stateDir: f.stateDir,
      configPaths: [configPath],
      oauthDirs: [],
      workspaceDirs: [],
      excludedWorkspaceDirs: [],
      agentRoots: [],
      pluginResources: [],
      pluginRoots: [pluginRoot],
    });
    expect(inventory.isIncluded(dependency)).toBe(false);
    const resources = await collectUpdateCheckpointResources({
      inventory,
      assets: [
        { kind: "state", sourcePath: f.stateDir, displayPath: f.stateDir, archivePath: "state" },
      ],
      databases: [],
      configFiles: [configPath, ...includes],
      serviceFiles: [service, serviceEnv, absentEnv],
      pluginRoots: [pluginRoot],
    });
    const ref = await captureUpdateCheckpoint({ ...f.access, resources, exclusions: [] });
    // These later lifecycle writes cannot change the already-captured preimage.
    await fs.writeFile(includePath, '{"port":18800}\n');
    await fs.writeFile(serviceEnv, "OPERATOR_LABEL=candidate\n");
    const checkpoint = await reopenUpdateCheckpoint(ref, f.access);
    for (const [sourcePath, expected] of [
      [includePath, '{"port":18789}\n'],
      [service, "[Service]\nEnvironmentFile=gateway.env\n"],
      [serviceEnv, "OPERATOR_LABEL=before\n"],
    ]) {
      const resource = checkpoint.manifest.resources.find(
        (entry) => entry.sourcePath === sourcePath,
      );
      expect(resource?.restore).toBe("replace");
      expect(resource?.artifact).toBeTruthy();
      expect(
        await fs.readFile(path.join(path.dirname(ref.manifestPath), resource!.artifact!), "utf8"),
      ).toBe(expected);
    }
    const absent = checkpoint.manifest.resources.find((entry) => entry.sourcePath === absentEnv);
    expect(absent).toMatchObject({
      kind: "service",
      artifact: null,
      captured: null,
      sourceState: null,
    });
    const plugin = checkpoint.manifest.resources.find((entry) => entry.sourcePath === pluginRoot);
    expect(
      await fs.readFile(
        path.join(
          path.dirname(ref.manifestPath),
          plugin!.artifact!,
          "node_modules/dependency/index.js",
        ),
        "utf8",
      ),
    ).toBe("export const version = 1;\n");
  });

  it("captures raw queue, lease and TTL state without applying archive sanitization or changing the live SQLite family", async () => {
    const f = await fixture();
    const file = path.join(f.stateDir, "openclaw.sqlite");
    const db = new DatabaseSync(file);
    try {
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      db.exec(`
        PRAGMA journal_mode=WAL;
        INSERT INTO state_leases(scope,lease_key,owner,expires_at,heartbeat_at,payload_json,created_at,updated_at)
          VALUES('fixture','active','fixture-owner',9000,40,'{"work":1}',1,40);
        INSERT INTO delivery_queue_entries(queue_name,id,status,entry_json,enqueued_at,updated_at)
          VALUES('fixture','pending','pending','{"work":2}',2,41);
        INSERT INTO plugin_blob_entries(plugin_id,namespace,entry_key,metadata_json,blob,created_at,expires_at)
          VALUES('fixture','ttl','output','{}',X'0001FF',3,8000);
      `);
    } finally {
      db.close();
    }
    const before = await fs.readFile(file);
    const ref = await captureUpdateCheckpoint({
      ...f.access,
      exclusions: [],
      resources: [{ sourcePath: file, kind: "sqlite", restore: "replace" }],
    });
    const checkpoint = await reopenUpdateCheckpoint(ref, f.access);
    const artifact = checkpoint.manifest.resources[0]?.artifact;
    expect(artifact).toBeTruthy();
    const snapshotPath = path.join(path.dirname(ref.manifestPath), artifact!);
    const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      expect(
        snapshotDb.prepare("SELECT owner, expires_at, payload_json FROM state_leases").all(),
      ).toEqual([{ owner: "fixture-owner", expires_at: 9000, payload_json: '{"work":1}' }]);
      expect(
        snapshotDb.prepare("SELECT status, entry_json FROM delivery_queue_entries").all(),
      ).toEqual([{ status: "pending", entry_json: '{"work":2}' }]);
      expect(
        snapshotDb.prepare("SELECT hex(blob) AS bytes, expires_at FROM plugin_blob_entries").all(),
      ).toEqual([{ bytes: "0001FF", expires_at: 8000 }]);
    } finally {
      snapshotDb.close();
    }
    // Control: the normal archive sanitizer intentionally cannot meet this contract.
    const archivePath = path.join(f.root, "archive.sqlite");
    await fs.copyFile(snapshotPath, archivePath);
    const archive = new DatabaseSync(archivePath);
    try {
      sanitizeOpenClawGlobalStateSnapshot(archive);
      for (const table of ["state_leases", "delivery_queue_entries", "plugin_blob_entries"]) {
        expect(archive.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
          count: 0,
        });
      }
    } finally {
      archive.close();
    }
    expect(await fs.readFile(file)).toEqual(before);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      await expect(fs.stat(`${file}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

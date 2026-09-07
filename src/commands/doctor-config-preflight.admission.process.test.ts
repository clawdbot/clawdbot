import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { repairAuditEventsSchema } from "../state/openclaw-state-db-audit-migration.js";
import {
  createSourceRuntime,
  runSourceRuntime,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

function manifest(root: string): Record<string, string> {
  // Coordinator locks under tmp/ are lifecycle scratch, not persisted operator state.
  // SQLite WAL readers update the shared-memory reader index (*-shm).
  // Accept that reader noise; main databases, WALs, and all other files stay byte-identical.
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .filter((relative) => relative.split(path.sep)[0] !== "tmp" && !relative.endsWith("-shm"))
      .toSorted()
      .map((relative) => [
        relative,
        createHash("sha256")
          .update(fs.readFileSync(path.join(root, relative)))
          .digest("hex"),
      ]),
  );
}

function schemaMetadata(databasePath: string) {
  // Inspect a private copy: opening a consolidated WAL database can itself create a WAL.
  const root = tempDirs.make("openclaw-admission-schema-");
  const copy = path.join(root, "database.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(`${databasePath}${suffix}`)) {
      fs.copyFileSync(`${databasePath}${suffix}`, `${copy}${suffix}`);
    }
  }
  const db = new DatabaseSync(copy);
  try {
    return {
      userVersion: db.prepare("PRAGMA user_version").get()?.user_version,
      schemaMeta: db.prepare("SELECT * FROM schema_meta ORDER BY rowid").all(),
    };
  } finally {
    db.close();
  }
}

describe("startup admission before persistent writes", () => {
  it.each([
    {
      name: "clobbered config with a healthy backup",
      workspace: false,
      repairable: false,
      config: "clobbered",
      restored: true,
      reason: "Config auto-restored from backup",
    },
    {
      name: "clobbered config with a legacy workspace in its backup",
      workspace: true,
      repairable: false,
      config: "clobbered",
      reason: "Legacy workspace setup state requires migration",
    },
    {
      name: "legacy workspace",
      workspace: true,
      repairable: false,
      config: "local",
      reason: "Legacy workspace setup state requires migration",
    },
    {
      name: "legacy workspace with repairable config",
      workspace: true,
      repairable: true,
      config: "local",
      reason: "Legacy workspace setup state requires migration",
    },
    {
      name: "session store selected by repaired agent ID",
      workspace: false,
      repairedSession: true,
      repairable: false,
      config: "local",
      reason: "Legacy session store requires migration",
    },
    {
      name: "missing config",
      workspace: false,
      repairable: false,
      config: "absent",
      reason: "Missing config",
    },
    {
      name: "missing config without an existing WAL",
      workspace: false,
      repairable: false,
      config: "absent",
      consolidated: true,
      reason: "Missing config",
    },
    {
      name: "invalid plugin without an existing WAL",
      workspace: false,
      repairable: true,
      config: "local",
      consolidated: true,
      invalidPlugin: true,
      reason: "OpenClaw config is invalid",
    },
    {
      name: "missing gateway.mode",
      workspace: false,
      repairable: false,
      config: "missing-mode",
      reason: "existing config is missing gateway.mode",
    },
    {
      name: "remote gateway.mode",
      workspace: false,
      repairable: false,
      config: "remote",
      reason: "set gateway.mode=local (current: remote)",
    },
  ])(
    "admits or preserves shipped state for $name",
    ({
      workspace,
      repairable,
      config,
      reason,
      consolidated,
      invalidPlugin,
      repairedSession,
      restored,
    }) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-startup-admission-"));
      const runtimeRoot = createSourceRuntime(root);
      const stateDir = path.join(root, "state");
      const workspaceDir = path.join(
        stateDir,
        config === "clobbered" ? "recovered-workspace" : "workspace",
      );
      const configPath = path.join(stateDir, "openclaw.json");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
      fs.mkdirSync(workspaceDir);
      fs.writeFileSync(
        databasePath,
        gunzipSync(fs.readFileSync("test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz")),
      );
      // Repair only the audit blocker; released schema 1 still needs automatic migration.
      // Keeping this idle connection open retains a real WAL in the manifest.
      const prepared = new DatabaseSync(databasePath);
      try {
        prepared.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
        repairAuditEventsSchema(prepared);
        if (consolidated) {
          prepared.close();
        }
        if (config !== "absent") {
          fs.writeFileSync(
            configPath,
            JSON.stringify({
              gateway:
                config === "missing-mode"
                  ? {}
                  : { mode: config === "clobbered" ? "local" : config },
              plugins: invalidPlugin
                ? { load: { paths: [path.join(root, "missing-plugin")] } }
                : { enabled: false },
              agents: repairedSession
                ? { list: [{ id: "" }] }
                : { defaults: { workspace: workspaceDir } },
              ...(repairedSession
                ? {
                    session: {
                      store: path.join(stateDir, "external", "{agentId}", "sessions.json"),
                    },
                  }
                : repairable
                  ? { session: { idleMinutes: 45 } }
                  : {}),
            }),
          );
          if (config === "clobbered") {
            fs.copyFileSync(configPath, `${configPath}.bak`);
            fs.writeFileSync(
              configPath,
              '{"update":{"channel":"stable"},"env":{"vars":{"OPENCLAW_GATEWAY_TOKEN":"discarded-test-token"}}}\n',
            );
          }
        }
        if (repairedSession) {
          const legacyStore = path.join(stateDir, "external", "agent", "sessions.json");
          fs.mkdirSync(path.dirname(legacyStore), { recursive: true });
          fs.writeFileSync(legacyStore, "{}\n");
        }
        if (workspace) {
          fs.writeFileSync(
            path.join(workspaceDir, "openclaw-workspace-state.json"),
            JSON.stringify({
              version: 1,
              bootstrapSeededAt: "2026-07-02T00:00:00.000Z",
              setupCompletedAt: "2026-07-02T00:00:00.000Z",
            }),
          );
        }
        fs.writeFileSync(
          path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
          '{"version":1,"profiles":{}}\n',
        );
        const schemaBefore = schemaMetadata(databasePath);
        const before = manifest(stateDir);
        expect(schemaBefore.userVersion).toBe(1);
        expect(Boolean(before[path.join("state", "openclaw.sqlite-wal")])).toBe(!consolidated);
        const entry =
          workspace || repairedSession
            ? `
        const { runDoctorConfigPreflight } = await import("./src/commands/doctor-config-preflight.ts");
        await runDoctorConfigPreflight({ migrateState: true, migrateLegacyConfig: false, requireStartupMigrationCheckpoint: true });
      `
            : `
        const { ensureConfigReady } = await import("./src/cli/program/config-guard.ts");
        const { ExitError } = await import("./src/runtime.ts");
        await ensureConfigReady({
          commandPath: ["gateway", "run"],
          runtime: { log: console.log, error: console.error, exit(code) { throw new ExitError(code); } },
        });
        if (${Boolean(restored)} && process.env.OPENCLAW_GATEWAY_TOKEN) {
          throw new Error("Discarded clobbered config environment leaked through admission.");
        }
      `;
        const result = runSourceRuntime(
          runtimeRoot,
          {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_WORKSPACE_DIR:
              config === "clobbered" ? path.join(stateDir, "empty-workspace") : workspaceDir,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
            NO_COLOR: "1",
          },
          [
            "--input-type=module",
            "--eval",
            `
        try {
          ${entry}
        } catch (error) {
          console.error(error.message);
          process.exitCode = typeof error.code === "number" ? error.code : 1;
        }
      `,
          ],
          60_000,
        );
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.error, output).toBeUndefined();
        expect(result.status, output).toBe(restored ? 0 : 78);
        expect(output).toContain(reason);
        if (restored) {
          expect(fs.readFileSync(configPath, "utf8")).toBe(
            fs.readFileSync(`${configPath}.bak`, "utf8"),
          );
          expect(schemaMetadata(databasePath).userVersion).toBe(16);
        } else {
          expect(manifest(stateDir)).toEqual(before);
          expect(schemaMetadata(databasePath)).toEqual(schemaBefore);
        }
      } finally {
        if (prepared.isOpen) {
          prepared.close();
        }
      }
    },
    75_000,
  );
});

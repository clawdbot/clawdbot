import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("Doctor CLI migration refusal", () => {
  it.each(["index.js", "entry.js"])(
    "refuses the 2026.9.2 updater through %s with its running ledger row only in WAL",
    (entry) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-doctor-update-wal-"));
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
      fs.writeFileSync(configPath, "{}\n");
      const shared = openOpenClawStateDatabase({ env }).path;
      createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, { env });
      closeOpenClawStateDatabaseForTest();
      const runtimeRoot = createBuiltRuntime(root, undefined, { copyDirectories: true });
      const packagePath = path.join(runtimeRoot, "package.json");
      const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      fs.writeFileSync(packagePath, JSON.stringify({ ...manifest, version: "2026.9.3" }));
      const writer = new DatabaseSync(shared);
      try {
        const row = writer.prepare("SELECT * FROM update_runs").get();
        if (!row) {
          throw new Error("Expected the fixture's update ledger row");
        }
        row.phase = "activating";
        writer.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
          UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
          DELETE FROM update_runs;
          PRAGMA wal_checkpoint(TRUNCATE);
        `);
        const checkpoint = fs.readFileSync(shared);
        writer
          .prepare(
            `INSERT INTO update_runs (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
              .map(() => "?")
              .join(",")})`,
          )
          .run(...Object.values(row));
        expect(fs.readFileSync(shared)).toEqual(checkpoint);
        expect(fs.statSync(`${shared}-wal`).size).toBeGreaterThan(32);
        const files = [shared, `${shared}-wal`, `${shared}-shm`, configPath];
        const before = files.map((file) => fs.readFileSync(file));

        // 2026.9.2 invokes the installed index directly and keeps its ledger open.
        const result = spawnSync(
          process.execPath,
          [path.join(runtimeRoot, "dist", entry), "doctor", "--non-interactive", "--fix"],
          {
            cwd: runtimeRoot,
            encoding: "utf8",
            timeout: 60_000,
            env: {
              PATH: process.env.PATH,
              HOME: root,
              USERPROFILE: root,
              ...env,
              OPENCLAW_UPDATE_IN_PROGRESS: "1",
              OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.3",
              OPENCLAW_SERVICE_REPAIR_POLICY: "external",
              NO_COLOR: "1",
              CI: "1",
            },
          },
        );
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.error, output).toBeUndefined();
        expect(result.status, output).toBe(1);
        expect(output).toContain(
          "Doctor refused update-time schema repair driven by OpenClaw 2026.9.2",
        );
        expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
        expect(writer.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION - 1,
        );
        expect(writer.prepare("SELECT * FROM update_runs").get()).toEqual(row);
      } finally {
        writer.close();
      }
    },
    60_000,
  );

  it.each([false, true])(
    "honors the ordered graph with valid TUI=%s",
    async (validTui) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-doctor-refusal-"));
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const tuiPath = path.join(stateDir, "tui", "last-session.json");
      const approvalsPath = path.join(stateDir, "exec-approvals.json");
      const tuiRaw = validTui
        ? JSON.stringify({
            terminal: { sessionKey: "agent:main:tui:behavior-validator", updatedAt: 100 },
          }) + "\n"
        : "not json\n";
      const approvalsRaw =
        JSON.stringify({
          version: 1,
          defaults: { security: "allowlist", ask: "on-miss" },
          agents: { main: { allowlist: [{ pattern: "/usr/bin/rg" }] } },
        }) + "\n";
      fs.mkdirSync(path.dirname(tuiPath), { recursive: true });
      fs.writeFileSync(configPath, "{}\n");
      fs.writeFileSync(tuiPath, tuiRaw);
      fs.writeFileSync(approvalsPath, approvalsRaw);
      const runtimeRoot = createBuiltRuntime(root);
      const result = runBuiltRuntime(
        runtimeRoot,
        {
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          NO_COLOR: "1",
          CI: "1",
        },
        ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
        60_000,
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.signal, output).toBeNull();
      const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      try {
        const approvals = db
          .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = 'current'")
          .all();
        if (validTui) {
          expect(result.status, output).toBe(0);
          expect(output).toContain("Doctor complete.");
          expect(output.indexOf("TUI last-session pointer(s)")).toBeGreaterThanOrEqual(0);
          expect(output.indexOf("Imported legacy exec approvals")).toBeGreaterThan(
            output.indexOf("TUI last-session pointer(s)"),
          );
          expect(fs.existsSync(tuiPath)).toBe(false);
          expect(fs.existsSync(approvalsPath)).toBe(false);
          expect(approvals).toHaveLength(1);
        } else {
          expect(fs.existsSync(approvalsPath), output).toBe(true);
          expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsRaw);
          expect(fs.readFileSync(tuiPath, "utf8")).toBe(tuiRaw);
          expect(approvals).toEqual([]);
          expect(result.status, output).toBe(1);
          expect(output).toContain("Failed reading legacy TUI last-session state");
          expect(output).not.toContain("Imported legacy exec approvals");
          expect(output).not.toContain("Doctor complete.");
          expect(output).not.toContain("rerun doctor --fix");
        }
      } finally {
        db.close();
      }
    },
    60_000,
  );
});

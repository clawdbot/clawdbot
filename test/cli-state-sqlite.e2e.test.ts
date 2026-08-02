// SQLite CLI E2E tests cover startup and target ownership before offline maintenance.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../src/state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../src/state/openclaw-state-db.js";

describe("SQLite CLI maintenance ownership", () => {
  it("compacts after full CLI startup without retaining a config-health database handle", async () => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, ".openclaw");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
        };
        delete env.OPENCLAW_CONFIG_PATH;
        delete env.OPENCLAW_HOME;
        delete env.VITEST;

        try {
          const database = openOpenClawStateDatabase({ env });
          database.db.exec(`
            CREATE TABLE compact_cli_payload (
              id INTEGER PRIMARY KEY,
              payload TEXT NOT NULL
            );
            BEGIN IMMEDIATE;
          `);
          const insert = database.db.prepare(
            "INSERT INTO compact_cli_payload (payload) VALUES (?)",
          );
          for (let index = 0; index < 256; index += 1) {
            insert.run(`${index}:${"x".repeat(8_192)}`);
          }
          database.db.exec(`
            COMMIT;
            DELETE FROM compact_cli_payload;
            PRAGMA wal_checkpoint(TRUNCATE);
          `);
        } finally {
          closeOpenClawStateDatabase();
        }

        const entry = path.resolve(process.cwd(), "src/entry.ts");
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", entry, "doctor", "--state-sqlite", "compact", "--json"],
          {
            cwd: process.cwd(),
            env,
            encoding: "utf8",
            timeout: 60_000,
          },
        );

        expect(result.status, result.stderr || result.stdout).toBe(0);
        const report = JSON.parse(result.stdout.trim()) as {
          after: { autoVacuum: number; freelistPages: number };
          before: { freelistPages: number };
          integrityCheck: string;
          skipped: boolean;
        };
        expect(report).toMatchObject({
          after: {
            autoVacuum: 2,
            freelistPages: 0,
          },
          integrityCheck: "ok",
          skipped: false,
        });
        expect(report.before.freelistPages).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
      },
      { prefix: "openclaw-state-sqlite-cli-" },
    );
  }, 90_000);

  it.skipIf(process.platform === "win32")(
    "rejects hard-linked shared-state SQLite sidecars before compaction",
    async () => {
      await withTempHome(
        async (tempHome) => {
          const stateDir = path.join(tempHome, ".openclaw");
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: tempHome,
            USERPROFILE: tempHome,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_TEST_FAST: "1",
          };
          delete env.OPENCLAW_CONFIG_PATH;
          delete env.OPENCLAW_HOME;
          delete env.VITEST;

          const database = openOpenClawStateDatabase({ env });
          const walPath = `${database.path}-wal`;
          const externalWalPath = path.join(tempHome, "external-state", "openclaw.sqlite-wal");
          try {
            database.db.exec(`
              PRAGMA wal_autocheckpoint = 0;
              CREATE TABLE compact_sidecar_payload (
                id INTEGER PRIMARY KEY,
                payload TEXT NOT NULL
              );
              PRAGMA wal_checkpoint(TRUNCATE);
              INSERT INTO compact_sidecar_payload (payload) VALUES ('committed wal frame');
            `);
            fs.mkdirSync(path.dirname(externalWalPath), { recursive: true });
            fs.linkSync(walPath, externalWalPath);
            const externalWalBefore = fs.readFileSync(externalWalPath);
            expect(externalWalBefore.byteLength).toBeGreaterThan(0);

            const entry = path.resolve(process.cwd(), "src/entry.ts");
            const result = spawnSync(
              process.execPath,
              ["--import", "tsx", entry, "doctor", "--state-sqlite", "compact", "--json"],
              {
                cwd: process.cwd(),
                env,
                encoding: "utf8",
                timeout: 60_000,
              },
            );

            expect(result.status).not.toBe(0);
            expect(`${result.stderr}\n${result.stdout}`).toContain("hard-linked path");
            expect(fs.readFileSync(externalWalPath)).toEqual(externalWalBefore);
          } finally {
            closeOpenClawStateDatabase();
          }
        },
        { prefix: "openclaw-state-sqlite-sidecar-cli-" },
      );
    },
    90_000,
  );

  it("rejects destructive explicit session stores outside the active state owner", async () => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, ".openclaw");
        const externalStorePath = path.join(
          tempHome,
          "external-state",
          "agents",
          "main",
          "sessions",
          "sessions.json",
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
        };
        delete env.OPENCLAW_CONFIG_PATH;
        delete env.OPENCLAW_HOME;
        delete env.VITEST;

        const entry = path.resolve(process.cwd(), "src/entry.ts");
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            entry,
            "doctor",
            "--session-sqlite",
            "compact",
            "--session-sqlite-store",
            externalStorePath,
            "--json",
          ],
          {
            cwd: process.cwd(),
            env,
            encoding: "utf8",
            timeout: 60_000,
          },
        );

        expect(result.status).not.toBe(0);
        expect(`${result.stderr}\n${result.stdout}`).toContain(
          "outside the active OpenClaw state directory",
        );
        expect(fs.existsSync(externalStorePath)).toBe(false);
      },
      { prefix: "openclaw-session-sqlite-cli-" },
    );
  }, 90_000);

  it("rejects hard-linked SQLite sidecars before destructive maintenance", async () => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, ".openclaw");
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        const sqlitePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
        const externalWalPath = path.join(tempHome, "external-state", "openclaw-agent.sqlite-wal");
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
        fs.mkdirSync(path.dirname(externalWalPath), { recursive: true });
        fs.writeFileSync(storePath, "{}\n", "utf8");
        fs.writeFileSync(externalWalPath, "external wal\n", "utf8");
        fs.linkSync(externalWalPath, `${sqlitePath}-wal`);
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
        };
        delete env.OPENCLAW_CONFIG_PATH;
        delete env.OPENCLAW_HOME;
        delete env.VITEST;

        const entry = path.resolve(process.cwd(), "src/entry.ts");
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            entry,
            "doctor",
            "--session-sqlite",
            "compact",
            "--session-sqlite-store",
            storePath,
            "--json",
          ],
          {
            cwd: process.cwd(),
            env,
            encoding: "utf8",
            timeout: 60_000,
          },
        );

        expect(result.status).not.toBe(0);
        expect(`${result.stderr}\n${result.stdout}`).toContain("hard-linked path");
        expect(fs.readFileSync(externalWalPath, "utf8")).toBe("external wal\n");
      },
      { prefix: "openclaw-session-sqlite-sidecar-cli-" },
    );
  }, 90_000);

  it.skipIf(process.platform === "win32")(
    "rejects symbolic-linked SQLite sidecars before destructive maintenance",
    async () => {
      await withTempHome(
        async (tempHome) => {
          const stateDir = path.join(tempHome, ".openclaw");
          const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
          const sqlitePath = path.join(
            stateDir,
            "agents",
            "main",
            "agent",
            "openclaw-agent.sqlite",
          );
          const targetPath = path.join(stateDir, "agents", "main", "agent", "sidecar-target");
          fs.mkdirSync(path.dirname(storePath), { recursive: true });
          fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
          fs.writeFileSync(storePath, "{}\n", "utf8");
          fs.writeFileSync(targetPath, "owned target\n", "utf8");
          fs.symlinkSync(targetPath, `${sqlitePath}-wal`);
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: tempHome,
            USERPROFILE: tempHome,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_TEST_FAST: "1",
          };
          delete env.OPENCLAW_CONFIG_PATH;
          delete env.OPENCLAW_HOME;
          delete env.VITEST;

          const entry = path.resolve(process.cwd(), "src/entry.ts");
          const result = spawnSync(
            process.execPath,
            [
              "--import",
              "tsx",
              entry,
              "doctor",
              "--session-sqlite",
              "compact",
              "--session-sqlite-store",
              storePath,
              "--json",
            ],
            {
              cwd: process.cwd(),
              env,
              encoding: "utf8",
              timeout: 60_000,
            },
          );

          expect(result.status).not.toBe(0);
          expect(`${result.stderr}\n${result.stdout}`).toContain("symbolic-link path");
          expect(fs.readFileSync(targetPath, "utf8")).toBe("owned target\n");
        },
        { prefix: "openclaw-session-sqlite-symlink-sidecar-cli-" },
      );
    },
    90_000,
  );

  it("rejects hard-linked SQLite sidecars discovered through configured session stores", async () => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, ".openclaw");
        const storePath = path.join(tempHome, "external-sessions", "sessions.json");
        const sqlitePath = path.join(path.dirname(storePath), "openclaw-agent.sqlite");
        const externalWalPath = path.join(tempHome, "external-alias", "openclaw-agent.sqlite-wal");
        const configPath = path.join(stateDir, "openclaw.json");
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.mkdirSync(path.dirname(externalWalPath), { recursive: true });
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(storePath, "{}\n", "utf8");
        fs.writeFileSync(configPath, JSON.stringify({ session: { store: storePath } }), "utf8");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
        };
        delete env.OPENCLAW_HOME;
        delete env.VITEST;

        const database = openOpenClawAgentDatabase({
          agentId: "main",
          env,
          path: sqlitePath,
        });
        const walPath = `${sqlitePath}-wal`;
        try {
          database.db.exec(`
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE compact_sidecar_payload (
              id INTEGER PRIMARY KEY,
              payload TEXT NOT NULL
            );
            PRAGMA wal_checkpoint(TRUNCATE);
            INSERT INTO compact_sidecar_payload (payload) VALUES ('committed wal frame');
          `);
          fs.linkSync(walPath, externalWalPath);
          const externalWalBefore = fs.readFileSync(externalWalPath);
          expect(externalWalBefore.byteLength).toBeGreaterThan(0);

          const entry = path.resolve(process.cwd(), "src/entry.ts");
          const result = spawnSync(
            process.execPath,
            ["--import", "tsx", entry, "doctor", "--session-sqlite", "compact", "--json"],
            {
              cwd: process.cwd(),
              env,
              encoding: "utf8",
              timeout: 60_000,
            },
          );

          expect(result.status).not.toBe(0);
          expect(`${result.stderr}\n${result.stdout}`).toContain("hard-linked path");
          expect(fs.readFileSync(externalWalPath)).toEqual(externalWalBefore);
        } finally {
          closeOpenClawAgentDatabaseByPath(sqlitePath);
        }
      },
      { prefix: "openclaw-configured-session-sqlite-sidecar-cli-" },
    );
  }, 90_000);
});

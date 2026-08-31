// Process regression for typed gateway startup-migration refusal and lease cleanup.
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { ensureOpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db.js";

const STARTUP_REFUSAL =
  "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.";
const STARTUP_RECOVERY =
  'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.';
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const execFileAsync = promisify(execFile);

function runIsolatedModuleScript(
  env: NodeJS.ProcessEnv,
  script: string,
  options: { runtimeRoot?: string; timeoutMs?: number } = {},
) {
  return execFileAsync(
    process.execPath,
    [
      ...(options.runtimeRoot ? ["--preserve-symlinks"] : []),
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: options.runtimeRoot ?? path.resolve("."),
      encoding: "utf8",
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: options.timeoutMs ?? 30_000,
    },
  );
}

function createSourceRuntime(root: string): string {
  const runtimeRoot = path.join(root, "runtime");
  fs.mkdirSync(path.join(runtimeRoot, "dist"), { recursive: true });
  for (const dirname of ["node_modules", "packages", "scripts", "src"]) {
    fs.symlinkSync(
      path.resolve(dirname),
      path.join(runtimeRoot, dirname),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  for (const filename of ["node-version.mjs", "package.json", "tsconfig.json"]) {
    fs.copyFileSync(path.resolve(filename), path.join(runtimeRoot, filename));
  }
  fs.writeFileSync(
    path.join(runtimeRoot, "dist", "build-info.json"),
    JSON.stringify({ builtAt: "2026-08-05T00:00:00.000Z" }),
  );
  return runtimeRoot;
}

function seedPluginStateConflict(stateDir: string): void {
  const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
  const sidecarPath = path.join(stateDir, "plugin-state", "state.sqlite");
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

  const shared = new DatabaseSync(sharedPath);
  try {
    shared.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      );
    `);
    shared
      .prepare(`
        INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run("discord", "components", "interaction:1", '{"ok":false}', 2_000, null);
  } finally {
    shared.close();
  }

  const sidecar = new DatabaseSync(sidecarPath);
  try {
    sidecar.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      );
    `);
    sidecar
      .prepare(`
        INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      // Older or equal sidecar rows can be archived; a newer divergent row must stay unresolved.
      .run("discord", "components", "interaction:1", '{"ok":true}', 3_000, null);
  } finally {
    sidecar.close();
  }
}

function seedOwnerlessSchemaOnlyAgentDatabase(stateDir: string): string {
  const databasePath = path.join(stateDir, "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    ensureOpenClawAgentDatabaseSchema(database, {
      agentId: "openclaw",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      path: databasePath,
      register: false,
    });
    database.prepare("UPDATE schema_meta SET agent_id = NULL WHERE meta_key = 'primary'").run();
  } finally {
    database.close();
  }
  return databasePath;
}

describe("doctor invalid config process exit", () => {
  it("migrates legacy exec approvals before repairing a partially valid config", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-doctor-legacy-approvals-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const approvalsPath = path.join(stateDir, "exec-approvals.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            {
              id: "jup",
              memorySearch: { enabled: true },
              tools: { message: { allowCrossContextSend: true } },
            },
          ],
        },
      }),
    );
    fs.writeFileSync(
      approvalsPath,
      JSON.stringify({
        version: 1,
        agents: {
          jup: {
            allowlist: [{ pattern: "/usr/bin/rg", lastUsedAt: null, lastUsedCommand: null }],
          },
        },
      }),
    );
    const runtimeRoot = createSourceRuntime(root);
    const uiDir = path.join(runtimeRoot, "dist", "control-ui");
    fs.mkdirSync(uiDir, { recursive: true });
    fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html>\n");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(runtimeRoot, "src", "entry.ts"),
        "doctor",
        "--repair",
        "--non-interactive",
        "--no-workspace-suggestions",
      ],
      { cwd: runtimeRoot, encoding: "utf8", env, timeout: 45_000 },
    );
    const output = `${result.stderr}\n${result.stdout}`;

    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(result.signal, output).toBeNull();
    expect(output).toContain("Imported legacy exec approvals into shared SQLite state.");
    expect(output).toContain("Doctor complete.");

    expect(fs.existsSync(approvalsPath)).toBe(false);
    const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    try {
      const row = database
        .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = 'current'")
        .get() as { raw_json?: string } | undefined;
      expect(row?.raw_json).toContain('"pattern": "/usr/bin/rg"');
      expect(row?.raw_json).not.toContain("lastUsedAt");
      expect(row?.raw_json).not.toContain("lastUsedCommand");
    } finally {
      database.close();
    }
  }, 45_000);

  it("exits after a complete best-effort report for an unparseable config", () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-doctor-invalid-config-exit-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.NODE_OPTIONS;
    delete env.OPENCLAW_GATEWAY_PASSWORD;
    delete env.OPENCLAW_GATEWAY_TOKEN;
    delete env.OPENCLAW_GATEWAY_URL;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, '{"agents": {broken json');

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("src/entry.ts"),
        "doctor",
        "--non-interactive",
        "--no-workspace-suggestions",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env,
        timeout: 60_000,
      },
    );
    const output = `${result.stderr}\n${result.stdout}`;

    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(result.signal, output).toBeNull();
    expect(output).toContain("Config invalid; doctor will run with best-effort config.");
    expect(output).toContain("Doctor complete.");
  }, 75_000);
});

// Synchronous CLI probes must not consume neighboring cases' timeout budgets.
describe("gateway startup-migration refusal", () => {
  it("repairs the stable upgrade config and additive state schema before readiness", async () => {
    const root = await fs.promises.realpath(tempDirs.make("openclaw-stable-upgrade-ready-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const stableConfig = {
      meta: {
        lastTouchedAt: "2026-08-01T00:00:00.000Z",
        lastTouchedVersion: "2026.7.1-2",
      },
      agents: { defaults: { heartbeat: { skipWhenBusy: true } } },
      gateway: { mode: "local", auth: { mode: "none" } },
    };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(stableConfig));
    const preflightUrl = new URL("./doctor-config-preflight.ts", import.meta.url).href;
    const stateDatabaseUrl = new URL("../state/openclaw-state-db.ts", import.meta.url).href;
    const script = `
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { DatabaseSync } = await import("node:sqlite");
      const { runDoctorConfigPreflight } = await import(${JSON.stringify(preflightUrl)});
      const { closeOpenClawStateDatabase, openOpenClawStateDatabase } =
        await import(${JSON.stringify(stateDatabaseUrl)});
      openOpenClawStateDatabase({ env: process.env });
      closeOpenClawStateDatabase();
      const oldDatabase = new DatabaseSync(${JSON.stringify(databasePath)});
      oldDatabase.exec("ALTER TABLE task_runs DROP COLUMN tool_use_count");
      oldDatabase.close();
      const legacyIdentityPath = path.join(${JSON.stringify(stateDir)}, "identity", "device.json");
      fs.mkdirSync(path.dirname(legacyIdentityPath), { recursive: true });
      fs.writeFileSync(legacyIdentityPath, JSON.stringify({
        deviceId: "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
        publicKey: "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
        privateKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        createdAtMs: 1700000000000,
      }));
      const result = await runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        observe: false,
        requireStartupMigrationCheckpoint: true,
        beforeStateMigrations: async () => true,
      });
      const config = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
      const repairedDatabase = new DatabaseSync(${JSON.stringify(databasePath)}, { readOnly: true });
      const columns = repairedDatabase.prepare("PRAGMA table_info(task_runs)").all();
      const identity = repairedDatabase
        .prepare("SELECT device_id FROM device_identities WHERE identity_key = 'primary'")
        .get();
      repairedDatabase.close();
      console.log("__RESULT__" + JSON.stringify({
        valid: result.snapshot.valid,
        hasLastTouchedAt: Object.hasOwn(config.meta ?? {}, "lastTouchedAt"),
        hasSkipWhenBusy: Object.hasOwn(config.agents?.defaults?.heartbeat ?? {}, "skipWhenBusy"),
        hasToolUseCount: columns.some((column) => column.name === "tool_use_count"),
        migratedDeviceIdentity: identity?.device_id === "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
        removedLegacyDeviceIdentity: !fs.existsSync(legacyIdentityPath),
      }));
    `;

    const result = await runIsolatedModuleScript(env, script, { timeoutMs: 60_000 });
    const output = `${result.stderr}\n${result.stdout}`;
    const resultLine = result.stdout.split("\n").find((line) => line.startsWith("__RESULT__"));

    expect(resultLine, output).toBeDefined();
    expect(JSON.parse(resultLine!.slice("__RESULT__".length))).toEqual({
      valid: true,
      hasLastTouchedAt: false,
      hasSkipWhenBusy: false,
      hasToolUseCount: true,
      migratedDeviceIdentity: true,
      removedLegacyDeviceIdentity: true,
    });
    expect(hasActiveStartupMigrationLease({ env })).toBe(false);
  }, 75_000);

  it("refuses readiness for a schema-only legacy agent database without an owner", () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-ownerless-agent-refusal-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const config = {
      gateway: { mode: "local", auth: { mode: "none" } },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, blocker: {}, digest: {} },
      },
    } satisfies OpenClawConfig;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config));
    const databasePath = seedOwnerlessSchemaOnlyAgentDatabase(stateDir);
    const preflightUrl = new URL("./doctor-config-preflight.ts", import.meta.url).href;
    const script = `
      const { runDoctorConfigPreflight } = await import(${JSON.stringify(preflightUrl)});
      try {
        await runDoctorConfigPreflight({
          migrateLegacyConfig: false,
          invalidConfigNote: false,
          observe: false,
          requireStartupMigrationCheckpoint: true,
        });
        console.log("__READY__");
      } catch (error) {
        console.error("__REFUSED__", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: path.resolve("."), encoding: "utf8", env, timeout: 60_000 },
    );
    const output = `${result.stderr}\n${result.stdout}`;

    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(result.stdout, output).not.toContain("__READY__");
    expect(result.stderr, output).toContain("__REFUSED__");
    expect(result.stderr, output).toContain(STARTUP_REFUSAL);
    expect(result.stderr, output).toContain(STARTUP_RECOVERY);
    expect(result.stderr, output).toContain("agent schema owner is missing or blank");
    expect(fs.existsSync(databasePath)).toBe(true);
    expect(hasActiveStartupMigrationLease({ env })).toBe(false);
  }, 75_000);

  it("reaches readiness with unresolved legacy agent files left for Doctor", async () => {
    const root = await fs.promises.realpath(tempDirs.make("openclaw-unresolved-agent-ready-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const legacyPath = path.join(stateDir, "agent", "settings.json");
    const config = {
      gateway: { mode: "local", auth: { mode: "none" } },
      agents: {
        ownership: "explicit",
        entries: { main: {}, blocker: {}, digest: {} },
      },
    } satisfies OpenClawConfig;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config));
    fs.writeFileSync(legacyPath, '{"legacy":true}\n');
    const preflightUrl = new URL("./doctor-config-preflight.ts", import.meta.url).href;
    const script = `
      const { runDoctorConfigPreflight } = await import(${JSON.stringify(preflightUrl)});
      await runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        observe: false,
        requireStartupMigrationCheckpoint: true,
      });
      console.log("__READY__");
    `;

    const result = await runIsolatedModuleScript(env, script, { timeoutMs: 60_000 });
    const output = `${result.stderr}\n${result.stdout}`;

    expect(result.stdout, output).toContain("__READY__");
    expect(output).toContain("Deferred legacy agent/session migration: select an agent owner");
    expect(fs.readFileSync(legacyPath, "utf8")).toBe('{"legacy":true}\n');
    expect(hasActiveStartupMigrationLease({ env })).toBe(false);
  }, 75_000);

  it("exits cleanly after reporting the refusal once and releasing its lease", async () => {
    const temporaryRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openclaw-startup-migration-exit-"),
    );
    const root = await fs.promises.realpath(temporaryRoot);
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;

    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const originalConfig = JSON.stringify({
        meta: { lastTouchedAt: "2026-08-01T00:00:00.000Z" },
        gateway: { mode: "local", auth: { mode: "none" } },
      });
      fs.writeFileSync(configPath, originalConfig);
      seedPluginStateConflict(stateDir);

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", path.resolve("src/entry.ts"), "gateway", "run", "--allow-unconfigured"],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env,
          timeout: 30_000,
        },
      );
      const output = `${result.stderr}\n${result.stdout}`;

      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(1);
      expect(result.signal, output).toBeNull();
      expect(result.stderr).toContain(STARTUP_REFUSAL);
      expect(result.stderr).toContain(STARTUP_RECOVERY);
      expect(result.stderr.split(STARTUP_REFUSAL)).toHaveLength(2);
      expect(result.stderr).not.toContain("[openclaw] Could not start the CLI.");
      expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);
      expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("refuses before relocating legacy state when a live gateway owns the state directory", async () => {
    // Live owner fixture with gateway-shaped argv: on Windows no file-lock start
    // time exists, so the lock reader validates the owner through process argv
    // (isGatewayArgv); the Vitest process itself would read as a dead owner there.
    const ownerChild = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 120_000)", "src/entry.ts", "gateway"],
      { cwd: path.resolve("."), stdio: "ignore" },
    );
    const temporaryRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openclaw-live-owner-refusal-"),
    );
    const root = await fs.promises.realpath(temporaryRoot);
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;

    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ gateway: { mode: "local", auth: { mode: "none" } } }),
      );
      // A pending automatic migration: legacy agent dir relocation moves this
      // file to agents/main/agent/ on the first unguarded gateway startup.
      const legacyAgentDir = path.join(stateDir, "agent");
      const legacyArtifactPath = path.join(legacyAgentDir, "auth-profiles.json");
      fs.mkdirSync(legacyAgentDir, { recursive: true });
      fs.writeFileSync(legacyArtifactPath, JSON.stringify({ profiles: {} }));
      // A pending state write admission side effect: a nonempty WAL beside a
      // missing main database gets copied to an .orphaned-* quarantine file by
      // sidecar quarantine unless the live-owner refusal runs first.
      const sharedStateDbDir = path.join(stateDir, "state");
      fs.mkdirSync(sharedStateDbDir, { recursive: true });
      const orphanWalPath = path.join(sharedStateDbDir, "openclaw.sqlite-wal");
      fs.writeFileSync(orphanWalPath, Buffer.alloc(64, 1));
      // A live gateway owner: the spawned gateway-shaped child is alive with a
      // matching start time, which is exactly how a real concurrent gateway verifies.
      const lockDir = resolveGatewayLockDir(stateDir);
      fs.mkdirSync(lockDir, { recursive: true });
      const startTime = getFileLockProcessStartTime(ownerChild.pid!);
      fs.writeFileSync(
        path.join(lockDir, "gateway.state.lock"),
        JSON.stringify({
          pid: ownerChild.pid,
          ownerId: "live-owner-refusal-test",
          createdAt: new Date().toISOString(),
          configPath,
          port: 18789,
          stateDir,
          ...(startTime !== null ? { startTime } : {}),
        }),
      );

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", path.resolve("src/entry.ts"), "gateway", "run", "--allow-unconfigured"],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env,
          timeout: 30_000,
        },
      );
      const output = `${result.stderr}\n${result.stdout}`;

      expect(result.error, output).toBeUndefined();
      // The refused startup must be side-effect-free: the pending legacy
      // relocation stayed untouched for the live owner.
      expect(fs.existsSync(legacyArtifactPath), output).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "agents", "main", "agent")), output).toBe(false);
      // No orphan-sidecar quarantine copy either: write admission never ran.
      expect(fs.readdirSync(sharedStateDbDir), output).toEqual(["openclaw.sqlite-wal"]);
      expect(result.status, output).toBe(1);
      expect(result.stderr, output).toContain("already owns this state directory");
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    } finally {
      ownerChild.kill();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("skips state-only checkpoint work when config and state remain absent", async () => {
    const root = await fs.promises.realpath(tempDirs.make("openclaw-configless-checkpoint-"));
    const runtimeRoot = createSourceRuntime(root);
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;

    const preflightUrl = pathToFileURL(
      path.join(runtimeRoot, "src", "commands", "doctor-config-preflight.ts"),
    ).href;
    const checkpointUrl = pathToFileURL(
      path.join(runtimeRoot, "src", "infra", "startup-migration-checkpoint.ts"),
    ).href;
    const script = `
      const steps = [];
      const { runDoctorConfigPreflight } = await import(${JSON.stringify(preflightUrl)});
      const { hasActiveStartupMigrationLease } = await import(${JSON.stringify(checkpointUrl)});
      await runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        observe: false,
        requireStateMigrationCheckpoint: true,
        measure: async (name, run) => {
          steps.push(name);
          return await run();
        },
      });
      console.log("__RESULT__" + JSON.stringify({
        activeLease: hasActiveStartupMigrationLease({ env: process.env }),
        stateMigrationsImported: steps.includes(
          "doctor.config-preflight.state-migrations-import",
        ),
      }));
    `;
    const run = () =>
      runIsolatedModuleScript(env, script, {
        runtimeRoot,
        timeoutMs: 60_000,
      });
    const readResult = (result: Awaited<ReturnType<typeof runIsolatedModuleScript>>) => {
      const resultLine = result.stdout.split("\n").find((line) => line.startsWith("__RESULT__"));
      expect(resultLine, `${result.stderr}\n${result.stdout}`).toBeDefined();
      return JSON.parse(resultLine!.slice("__RESULT__".length)) as {
        activeLease: boolean;
        stateMigrationsImported: boolean;
      };
    };

    const first = readResult(await run());
    const second = readResult(await run());

    // This direct preflight is state-only. Gateway startup requests the readiness checkpoint and
    // still imports it; the preceding process case proves migration failures refuse readiness.
    expect(first).toEqual({ activeLease: false, stateMigrationsImported: false });
    expect(second).toEqual({ activeLease: false, stateMigrationsImported: false });
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
  }, 150_000);

  it("reloads tool ownership after updater-managed manifest repair", async () => {
    const root = await fs.promises.realpath(tempDirs.make("openclaw-updater-manifest-repair-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const pluginId = "updater-tool-owner";
    const pluginDir = path.join(root, "plugins", pluginId);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const config = {
      gateway: { mode: "local", auth: { mode: "none" } },
      plugins: {
        load: { paths: [pluginDir] },
        entries: { [pluginId]: { enabled: true } },
      },
    } satisfies OpenClawConfig;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;

    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config));
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: `@openclaw/${pluginId}`,
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        id: pluginId,
        tools: ["updater_tool"],
        configSchema: { type: "object" },
      }),
    );

    const configFlowUrl = new URL("./doctor-config-flow.ts", import.meta.url).href;
    const currentSnapshotUrl = new URL(
      "../plugins/current-plugin-metadata-snapshot.ts",
      import.meta.url,
    ).href;
    const healthRunnersUrl = new URL(
      "../flows/doctor-health-contribution-runners.state.ts",
      import.meta.url,
    ).href;
    const prompterUrl = new URL("./doctor-prompter.ts", import.meta.url).href;
    const result = await runIsolatedModuleScript(
      env,
      `
        const fs = await import("node:fs");
        const { loadAndMaybeMigrateDoctorConfig } = await import(${JSON.stringify(configFlowUrl)});
        const { getCurrentPluginMetadataSnapshot } =
          await import(${JSON.stringify(currentSnapshotUrl)});
        const { runLegacyPluginManifestHealth } = await import(${JSON.stringify(healthRunnersUrl)});
        const { createDoctorPrompter } = await import(${JSON.stringify(prompterUrl)});
        const options = { nonInteractive: true, repair: true };
        const runtime = {
          log: () => {},
          warn: () => {},
          error: () => {},
          exit: (code) => { throw new Error("doctor exited " + code); },
        };
        const prompter = createDoctorPrompter({ runtime, options });
        const configResult = await loadAndMaybeMigrateDoctorConfig({
          options,
          confirm: async () => false,
          runtime,
          prompter,
        });
        const readToolOwners = () =>
          configResult.runWithPluginMetadataSnapshot(
            { config: configResult.cfg },
            () => [
              ...(getCurrentPluginMetadataSnapshot({ config: configResult.cfg })
                ?.owners.contracts.get("tools") ?? []),
            ],
          );
        const before = readToolOwners();
        await runLegacyPluginManifestHealth({
          cfg: configResult.cfg,
          runtime,
          prompter,
          invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
        });
        const after = readToolOwners();
        const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(manifestPath)}, "utf8"));
        console.log("__RESULT__" + JSON.stringify({
          retainedBaseSnapshot: configResult.pluginMetadataSnapshot !== undefined,
          before,
          after,
          legacyTools: manifest.tools,
          contractTools: manifest.contracts?.tools,
        }));
      `,
      { timeoutMs: 60_000 },
    );
    const resultLine = result.stdout.split("\n").find((line) => line.startsWith("__RESULT__"));
    expect(resultLine, `${result.stderr}\n${result.stdout}`).toBeDefined();
    expect(JSON.parse(resultLine!.slice("__RESULT__".length))).toEqual({
      retainedBaseSnapshot: false,
      before: [],
      after: [pluginId],
      contractTools: ["updater_tool"],
    });
  }, 90_000);
});

describe("CLI pristine startup after early config observation", () => {
  it.each([
    { name: "explicit Gateway target", explicit: true, existingState: false, stateful: false },
    { name: "configured Gateway target", explicit: false, existingState: false, stateful: false },
    { name: "existing shared state", explicit: true, existingState: true, stateful: false },
    { name: "stateful authored config", explicit: true, existingState: false, stateful: true },
  ])(
    "preserves the migration decision for $name",
    async ({ explicit, existingState, stateful }) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-cli-pristine-observation-"));
      const runtimeRoot = createSourceRuntime(root);
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const timelinePath = path.join(root, "timeline.jsonl");
      const config = {
        gateway: { mode: "local", port: 19876, auth: { mode: "token", token: "test-token" } },
        agents: { defaults: { workspace: path.join(root, "workspace") } },
        logging: { file: path.join(root, "openclaw.log") },
        // Inherited plugin selectors must not add unrelated convergence work to this fixture.
        plugins: { enabled: false },
        ...(stateful ? { messages: { ackReaction: "ok" } } : {}),
      } satisfies OpenClawConfig;
      const configRaw = JSON.stringify(config);
      fs.writeFileSync(configPath, configRaw);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DIAGNOSTICS: "1",
        OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
        OPENCLAW_HIDE_BANNER: "1",
        XDG_CONFIG_HOME: path.join(root, "xdg-config"),
        XDG_DATA_HOME: path.join(root, "xdg-data"),
        XDG_STATE_HOME: path.join(root, "xdg-state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        TMPDIR: root,
        NO_COLOR: "1",
      };
      delete env.NODE_ENV;
      delete env.VITEST;
      delete env.VITEST_POOL_ID;
      delete env.VITEST_WORKER_ID;
      delete env.OPENCLAW_PROFILE;
      delete env.OPENCLAW_CONTAINER;
      delete env.OPENCLAW_GATEWAY_URL;
      delete env.OPENCLAW_GATEWAY_TOKEN;
      delete env.OPENCLAW_GATEWAY_PASSWORD;
      // Check the authored input without warming the CLI child's startup graph.
      const { planPristineStartupConfigMigrations } =
        await import("./doctor/shared/pristine-startup-state.js");
      expect(planPristineStartupConfigMigrations(config, env)).toEqual({
        skipAllStateMigrations: !stateful,
        skipCoreStateMigrations: !stateful,
      });
      const sourceUrl = (relative: string) =>
        pathToFileURL(path.join(runtimeRoot, "src", relative)).href;
      const args = [
        "attach",
        "movies-a1166b81",
        ...(explicit ? ["--url", "ws://127.0.0.1:19877", "--token", "test-token"] : []),
      ];
      const rpcSource = `
      export * from ${JSON.stringify(sourceUrl("gateway/call.ts"))};
      export async function callGateway(options) {
        if (options.method !== "sessions.resolve") throw new Error("Unexpected RPC: " + options.method);
        globalThis[Symbol.for("openclaw.test.pristineStartupRpcCalls")].push({
          method: options.method, params: options.params, url: options.url ?? null,
          configMode: options.config?.gateway?.mode, configPort: options.config?.gateway?.port,
        });
        return { ok: false, candidates: [
          { key: "agent:main:task:a1166b81-1111-4111-8111-111111111111", displayName: "first" },
          { key: "agent:main:task:a1166b81-2222-4222-8222-222222222222", displayName: "second" },
        ] };
      }
    `;
      // Exercise the real early read, Commander preaction and Doctor decision. Only the
      // resolution RPC is synthetic; ambiguity stops before grants or an external client.
      const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { DatabaseSync } from "node:sqlite";
      import { registerHooks } from "node:module";
      const calls = globalThis[Symbol.for("openclaw.test.pristineStartupRpcCalls")] = [];
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const parent = context.parentURL ?? "";
          if (specifier.endsWith("/gateway/call.js") &&
              (parent.endsWith("/cli/session-target.ts") || parent.endsWith("/cli/session-target.js"))) {
            return { shortCircuit: true,
              url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(rpcSource)}) };
          }
          return nextResolve(specifier, context);
        },
      });
      if (${existingState}) {
        const { openOpenClawStateDatabase, closeOpenClawStateDatabase } =
          await import(${JSON.stringify(sourceUrl("state/openclaw-state-db.ts"))});
        openOpenClawStateDatabase({ env: process.env });
        closeOpenClawStateDatabase();
      }
      const databasePath = path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
      const databaseExistedBefore = fs.existsSync(databasePath);
      const { runCli } = await import(${JSON.stringify(sourceUrl("cli/run-main.ts"))});
      process.argv = [process.execPath, "openclaw", ...${JSON.stringify(args)}];
      let message;
      try { await runCli(process.argv); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      const { flushDiagnosticsTimeline } =
        await import(${JSON.stringify(sourceUrl("infra/diagnostics-timeline.ts"))});
      flushDiagnosticsTimeline();
      const events = fs.readFileSync(process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH, "utf8")
        .trim().split("\\n").map(line => JSON.parse(line));
      const stages = events.filter(event => event.type === "span.end" &&
        event.name === "cli.command-startup").map(event => event.attributes?.stage);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      let health;
      try { health = database.prepare("SELECT last_known_good_json FROM config_health_entries WHERE config_path = ?")
        .get(process.env.OPENCLAW_CONFIG_PATH); }
      finally { database.close(); }
      process.stdout.write("__RESULT__" + JSON.stringify({
        message, calls, stages, databaseExistedBefore,
        observedConfigMode: health ? JSON.parse(health.last_known_good_json).gatewayMode : null,
      }) + "\\n");
    `;
      const result = await runIsolatedModuleScript(env, script, { runtimeRoot, timeoutMs: 60_000 });
      const output = `${result.stderr}\n${result.stdout}`;
      const resultLines = result.stdout.split("\n").filter((line) => line.startsWith("__RESULT__"));
      expect(resultLines, output).toHaveLength(1);
      const observed = JSON.parse(resultLines[0]!.slice("__RESULT__".length));
      expect(observed.message).toContain("Session reference is ambiguous:");
      expect(observed.message).toContain("first");
      expect(observed.message).toContain("second");
      expect(observed.calls).toEqual([
        {
          method: "sessions.resolve",
          params: { shortId: "a1166b81", slugHint: "movies" },
          url: explicit ? "ws://127.0.0.1:19877" : null,
          configMode: "local",
          configPort: 19876,
        },
      ]);
      expect(observed.databaseExistedBefore).toBe(existingState);
      expect(observed.observedConfigMode).toBe("local");
      expect(observed.stages).toContain("config-ready");
      expect(observed.stages).toContain("doctor.config-preflight.config-snapshot");
      expect(observed.stages.includes("doctor.config-preflight.state-migrations-import")).toBe(
        existingState || stateful,
      );
      expect(fs.readFileSync(configPath, "utf8")).toBe(configRaw);
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    },
    75_000,
  );
});

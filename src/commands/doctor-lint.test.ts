import { createHash } from "node:crypto";
// Doctor lint tests cover health-check registry integration and lint warning output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runDoctorLintCli } from "./doctor-lint.js";

const mocks = vi.hoisted(() => ({
  actualOpenNodeSqliteDatabase: vi.fn(),
  actualPrepareSqliteReadOnlyLocationSync: vi.fn(),
  actualReadConfigFileSnapshot: vi.fn(),
  openNodeSqliteDatabase: vi.fn(),
  prepareSqliteReadOnlyLocationSync: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveDoctorContributionHealthChecks: vi.fn(),
  shouldIsolatePluginStateForBundledHealthChecks: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  mocks.actualReadConfigFileSnapshot.mockImplementation(actual.readConfigFileSnapshot);
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  };
});
vi.mock("../infra/sqlite-readonly-location.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-readonly-location.js")>();
  mocks.actualPrepareSqliteReadOnlyLocationSync.mockImplementation(
    actual.prepareSqliteReadOnlyLocationSync,
  );
  mocks.prepareSqliteReadOnlyLocationSync.mockImplementation(
    actual.prepareSqliteReadOnlyLocationSync,
  );
  return {
    ...actual,
    prepareSqliteReadOnlyLocationSync: mocks.prepareSqliteReadOnlyLocationSync,
  };
});
vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  mocks.actualOpenNodeSqliteDatabase.mockImplementation(actual.openNodeSqliteDatabase);
  mocks.openNodeSqliteDatabase.mockImplementation((...args: unknown[]) =>
    mocks.actualOpenNodeSqliteDatabase(...args),
  );
  return {
    ...actual,
    openNodeSqliteDatabase: mocks.openNodeSqliteDatabase,
  };
});
vi.mock("../flows/bundled-health-checks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flows/bundled-health-checks.js")>();
  mocks.shouldIsolatePluginStateForBundledHealthChecks.mockImplementation(
    actual.shouldIsolatePluginStateForBundledHealthChecks,
  );
  return {
    ...actual,
    shouldIsolatePluginStateForBundledHealthChecks:
      mocks.shouldIsolatePluginStateForBundledHealthChecks,
  };
});
vi.mock("../flows/doctor-health-contributions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flows/doctor-health-contributions.js")>();
  mocks.resolveDoctorContributionHealthChecks.mockImplementation(
    actual.resolveDoctorContributionHealthChecks,
  );
  return {
    ...actual,
    resolveDoctorContributionHealthChecks: (...args: unknown[]) =>
      mocks.resolveDoctorContributionHealthChecks(...args),
  };
});

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("runDoctorLintCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockReset();
    clearHealthChecksForTest();
  });

  it("bases exit code on the selected severity threshold", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        severityMin: "error",
        onlyIds: ["core/doctor/final-config-validation"],
      });

      expect(exitCode).toBe(0);
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
      expect(String(stdout.mock.calls.at(-1)?.[0])).toContain('"findings":[]');
    } finally {
      stdout.mockRestore();
    }
  });

  it("reports the visible finding count in human output", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        severityMin: "error",
        onlyIds: ["core/doctor/final-config-validation"],
      });

      expect(exitCode).toBe(0);
      expect(String(stdout.mock.calls[0]?.[0])).toContain("0 finding(s)");
      expect(String(stdout.mock.calls[1]?.[0])).toBe("  no findings\n");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
      stdout.mockRestore();
    }
  });

  it("does not expose deep mode to extension health check context", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });
    const detect = vi.fn(async (_ctx: unknown) => []);
    registerHealthCheck({
      id: "test/deep-context",
      kind: "plugin",
      description: "test extension context",
      detect,
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runDoctorLintCli(runtime, {
        deep: true,
        onlyIds: ["test/deep-context"],
      });

      expect(detect).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "lint",
        }),
      );
      expect(detect.mock.calls[0]?.[0]).not.toHaveProperty("deep");
    } finally {
      stdout.mockRestore();
    }
  });

  it("emits structured JSON for invalid config snapshots", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      path: "/tmp/openclaw.json",
      issues: [{ path: "gateway.mode", message: "Required" }],
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, { json: true });

      expect(exitCode).toBe(1);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({
        ok: false,
        checksRun: 1,
        findings: [
          {
            checkId: "core/doctor/final-config-validation",
            severity: "error",
            message: "Required",
            path: "gateway.mode",
          },
        ],
      });
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it("rejects unknown --only health check ids instead of reporting a false-clean run", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        onlyIds: ["core/doctor/not-a-check"],
      });

      expect(exitCode).toBe(1);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({
        ok: false,
        checksRun: 0,
        findings: [
          {
            checkId: "core/doctor/lint-selection",
            severity: "error",
            path: "core/doctor/not-a-check",
          },
        ],
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it("reports disabled Codex plugin routes through doctor lint", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "gpt-5.5",
            },
          },
        },
      } as unknown as OpenClawConfig,
      path: "/tmp/openclaw.json",
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        onlyIds: ["core/doctor/codex-session-routes"],
      });

      expect(exitCode).toBe(1);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({
        ok: false,
        checksRun: 1,
        findings: [
          {
            checkId: "core/doctor/codex-session-routes",
            severity: "warning",
            path: "agents.defaults.model.primary",
            target: "openai/gpt-5.5",
          },
        ],
      });
      expect(payload.findings[0].message).toContain("Codex plugin is disabled by config");
      // Explicit plugins.entries.codex.enabled=false blocks auto-repair, so the
      // hint names the manual action instead of promising doctor --fix.
      expect(payload.findings[0].fixHint).toContain("Enable plugins.entries.codex");
    } finally {
      stdout.mockRestore();
    }
  });

  it("runs core contribution checks plus registered extension checks", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });
    registerHealthCheck({
      id: "plugin/example/lint",
      kind: "plugin",
      description: "example plugin lint check",
      async detect() {
        return [
          {
            checkId: "plugin/example/lint",
            severity: "info",
            message: "plugin finding",
            fixHint: "Review the plugin finding.",
          },
        ];
      },
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        onlyIds: ["core/doctor/final-config-validation", "plugin/example/lint"],
      });

      expect(exitCode).toBe(0);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload.ok).toBe(true);
      expect(payload.checksRun).toBe(2);
      expect(payload.findings).toEqual([]);
    } finally {
      stdout.mockRestore();
    }
  });

  it("fails informational findings when severity-min is explicit", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });
    registerHealthCheck({
      id: "plugin/example/lint",
      kind: "plugin",
      description: "example plugin lint check",
      async detect() {
        return [
          {
            checkId: "plugin/example/lint",
            severity: "info",
            message: "plugin finding",
            fixHint: "Review the plugin finding.",
          },
        ];
      },
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        severityMin: "info",
        onlyIds: ["plugin/example/lint"],
      });

      expect(exitCode).toBe(1);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload.ok).toBe(false);
      expect(payload.findings).toEqual([
        {
          checkId: "plugin/example/lint",
          severity: "info",
          message: "plugin finding",
          fixHint: "Review the plugin finding.",
        },
      ]);
      expect(mocks.resolveDoctorContributionHealthChecks).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it("does not require shared state inspection for an unrelated selected check", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-state-"));
    const stateDir = path.join(rootDir, "operator-state");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, "not a sqlite database");
    const sourceContents = fs.readFileSync(databasePath);
    const sourceEntries = fs.readdirSync(path.dirname(databasePath)).toSorted();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runDoctorLintCli(runtime, {
          json: true,
          severityMin: "error",
          onlyIds: ["core/doctor/final-config-validation"],
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: true,
        checksRun: 1,
        findings: [],
      });
      expect(fs.readFileSync(databasePath)).toEqual(sourceContents);
      expect(fs.readdirSync(path.dirname(databasePath)).toSorted()).toEqual(sourceEntries);
    } finally {
      stdout.mockRestore();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("reads config and plugin metadata from private state for the isolated selected check", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-private-"));
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = {
      gateway: { mode: "local" },
      agents: { defaults: { workspace: "${OPENCLAW_STATE_DIR}/workspace" } },
      memory: { search: { provider: "local", fallback: "none" } },
    } satisfies OpenClawConfig;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const env = {
      ...process.env,
      HOME: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    await writePersistedInstalledPluginIndexInstallRecords(
      {},
      { config, env, stateDir, workspaceDir: rootDir },
    );
    const databasePath = resolveOpenClawStateSqlitePath(env);
    closeOpenClawStateDatabaseByPath(databasePath);
    const before = snapshotSqliteFamily(databasePath);
    mocks.openNodeSqliteDatabase.mockClear();
    const sourceOpenStacks: string[] = [];
    mocks.openNodeSqliteDatabase.mockImplementation((...args: unknown[]) => {
      if (args[0] === databasePath) {
        sourceOpenStacks.push(new Error("source database opened").stack ?? "");
      }
      return mocks.actualOpenNodeSqliteDatabase(...args);
    });
    const originalEnv = {
      HOME: process.env.HOME,
      OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    };
    Object.assign(process.env, {
      HOME: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    });
    mocks.readConfigFileSnapshot.mockImplementation((...args: unknown[]) =>
      mocks.actualReadConfigFileSnapshot(...args),
    );
    mocks.shouldIsolatePluginStateForBundledHealthChecks.mockReturnValueOnce(true);
    const inspectSourceConfig = vi.fn(async (ctx: { cfg: OpenClawConfig }) => {
      expect(ctx.cfg.agents?.defaults?.workspace).toBe(path.join(stateDir, "workspace"));
      return [];
    });
    registerHealthCheck({
      id: "test/source-config-interpolation",
      kind: "plugin",
      description: "checks source-path interpolation",
      detect: inspectSourceConfig,
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runDoctorLintCli(runtime, {
          json: true,
          severityMin: "error",
          onlyIds: [
            "memory-core/managed-local-embedding-setup",
            "test/source-config-interpolation",
          ],
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: true,
        checksRun: 2,
        findings: [],
      });
      expect(inspectSourceConfig).toHaveBeenCalledOnce();
      expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
      expect(sourceOpenStacks).toEqual([]);
      expect(snapshotSqliteFamily(databasePath)).toEqual(before);
    } finally {
      stdout.mockRestore();
      restoreEnv(originalEnv);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("fails closed with structured JSON when isolated state cannot be prepared", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-failure-"));
    const stateDir = path.join(rootDir, "operator-state");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.close();
    mocks.prepareSqliteReadOnlyLocationSync.mockImplementationOnce(() => {
      throw new Error("shared state did not stabilize");
    });
    mocks.shouldIsolatePluginStateForBundledHealthChecks.mockReturnValueOnce(true);

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        severityMin: "error",
        onlyIds: ["memory-core/managed-local-embedding-setup"],
      });

      expect(exitCode).toBe(1);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        checksRun: 0,
        findings: [
          {
            checkId: "core/doctor/lint-state-inspection",
            severity: "error",
            target: "plugin-state",
            requirement: "read-only-plugin-state-inspection",
            message: expect.stringContaining("shared state did not stabilize"),
          },
        ],
      });
      expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("emits one structured failure when isolated state cleanup does not complete", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-cleanup-"));
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = { gateway: { mode: "local" } } satisfies OpenClawConfig;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const env = {
      ...process.env,
      HOME: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    await writePersistedInstalledPluginIndexInstallRecords(
      {},
      { config, env, stateDir, workspaceDir: rootDir },
    );
    closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
    const originalEnv = {
      HOME: process.env.HOME,
      OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    };
    Object.assign(process.env, env);
    mocks.shouldIsolatePluginStateForBundledHealthChecks.mockReturnValueOnce(true);
    mocks.prepareSqliteReadOnlyLocationSync.mockImplementationOnce((...args: unknown[]) => {
      const prepared = mocks.actualPrepareSqliteReadOnlyLocationSync(...args);
      return {
        ...prepared,
        cleanup() {
          prepared.cleanup();
          return false;
        },
      };
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        severityMin: "error",
        onlyIds: ["memory-core/managed-local-embedding-setup"],
      });

      expect(exitCode).toBe(1);
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        checksRun: 0,
        findings: [
          {
            checkId: "core/doctor/lint-state-inspection",
            severity: "error",
            requirement: "read-only-plugin-state-inspection",
            message: expect.stringContaining("cleanup did not complete"),
          },
        ],
      });
    } finally {
      stdout.mockRestore();
      restoreEnv(originalEnv);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      title: "rejects extension checks that reuse ordered core check ids",
      checkId: "core/doctor/final-config-validation",
      kind: "plugin",
      description: "colliding plugin lint check",
      expectedError: "health check already registered: core/doctor/final-config-validation",
    },
    {
      title: "rejects registered core-kind checks that reuse ordered core check ids",
      checkId: "core/doctor/final-config-validation",
      kind: "core",
      description: "colliding core-kind lint check",
      expectedError: "health check already registered: core/doctor/final-config-validation",
    },
    {
      title: "rejects extension checks that claim unused reserved core doctor ids",
      checkId: "core/doctor/not-yet-owned",
      kind: "plugin",
      description: "reserved plugin lint check",
      expectedError: "health check already registered: core/doctor/not-yet-owned",
    },
    {
      title: "rejects registered core-kind checks that claim unused reserved core doctor ids",
      checkId: "core/doctor/not-yet-owned",
      kind: "core",
      description: "reserved core-kind lint check",
      expectedError: "health check already registered: core/doctor/not-yet-owned",
    },
  ] as const)("$title", async ({ checkId, kind, description, expectedError }) => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });
    registerHealthCheck({
      id: checkId,
      kind,
      description,
      async detect() {
        return [];
      },
    });

    await expect(runDoctorLintCli(runtime, { json: true })).rejects.toThrow(expectedError);
  });

  it("rejects invalid severity thresholds", async () => {
    await expect(runDoctorLintCli(runtime, { severityMin: "warnng" })).rejects.toThrow(
      "Invalid --severity-min value",
    );
  });
});

function snapshotSqliteFamily(databasePath: string): Array<{
  path: string;
  sha256: string;
}> {
  return ["", "-journal", "-shm", "-wal"]
    .map((suffix) => `${databasePath}${suffix}`)
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({
      path: candidate,
      sha256: createHash("sha256").update(fs.readFileSync(candidate)).digest("hex"),
    }));
}

function restoreEnv(values: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

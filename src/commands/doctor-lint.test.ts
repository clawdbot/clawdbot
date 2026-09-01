import { createHash } from "node:crypto";
// Doctor lint tests cover health-check registry integration and lint warning output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as bundledHealthChecks from "../flows/bundled-health-checks.js";
import { CORE_HEALTH_CHECKS } from "../flows/doctor-core-checks.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-record-cache.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runDoctorLintCli } from "./doctor-lint.js";

const mocks = vi.hoisted(() => ({
  actualOpenNodeSqliteDatabase: vi.fn(),
  actualPrepareSqliteReadOnlyLocationSync: vi.fn(),
  actualReadConfigFileSnapshot: vi.fn(),
  buildGatewayProbeConnectionDetails: vi.fn(),
  callGateway: vi.fn(),
  openNodeSqliteDatabase: vi.fn(),
  prepareSqliteReadOnlyLocationSync: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveDoctorContributionHealthChecks: vi.fn(),
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
vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return {
    ...actual,
    buildGatewayProbeConnectionDetails: mocks.buildGatewayProbeConnectionDetails,
    callGateway: mocks.callGateway,
  };
});
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID = "crabbox/cloud-worker-profiles";

describe("runDoctorLintCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockReset();
    mocks.buildGatewayProbeConnectionDetails.mockReset().mockResolvedValue({
      url: "ws://127.0.0.1:18789",
    });
    mocks.callGateway.mockReset().mockResolvedValue({ degradedSecretOwners: [] });
    mocks.openNodeSqliteDatabase.mockImplementation((...args: unknown[]) =>
      mocks.actualOpenNodeSqliteDatabase(...args),
    );
    mocks.prepareSqliteReadOnlyLocationSync.mockReset();
    mocks.prepareSqliteReadOnlyLocationSync.mockImplementation((...args: unknown[]) =>
      mocks.actualPrepareSqliteReadOnlyLocationSync(...args),
    );
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

  it.each([
    { label: "--only JSON", selection: "only", json: true },
    { label: "--only human text", selection: "only", json: false },
    { label: "--all JSON", selection: "all", json: true },
    { label: "--all human text", selection: "all", json: false },
    { label: "default JSON", selection: "default", json: true },
    { label: "default human text", selection: "default", json: false },
  ] as const)("keeps Gateway-owned secret degradation observable through $label", async (entry) => {
    const gatewayCheck = CORE_HEALTH_CHECKS.find(
      (check) => check.id === "core/doctor/gateway-health",
    );
    expect(gatewayCheck).toBeDefined();
    const previousResolveChecks =
      mocks.resolveDoctorContributionHealthChecks.getMockImplementation();
    mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([gatewayCheck]);
    const registerChecks = vi
      .spyOn(bundledHealthChecks, "registerBundledHealthChecks")
      .mockImplementation(() => {});
    const resolveStateMode = vi
      .spyOn(bundledHealthChecks, "resolveBundledHealthCheckPluginStateMode")
      .mockReturnValue("direct");
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "SYNTHETIC_GATEWAY_SECRET" },
        },
      },
      path: "/tmp/openclaw.json",
    });
    mocks.callGateway.mockResolvedValue({
      degradedSecretOwners: [
        {
          ownerKind: "account",
          ownerId: "discord:ops",
          state: "unavailable",
          paths: ["channels.discord.accounts.ops.token"],
          reason:
            "secret reference was not found (env:default:PRIVATE_REF_ID=SYNTHETIC_OWNER_SECRET)",
        },
      ],
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: !entry.json });

    try {
      const exitCode = await runDoctorLintCli(runtime, {
        ...(entry.json ? { json: true } : {}),
        ...(entry.selection === "only"
          ? { onlyIds: ["core/doctor/gateway-health"] }
          : entry.selection === "all"
            ? { includeAllChecks: true }
            : {}),
      });
      const output = stdout.mock.calls.map(([line]) => String(line)).join("");

      if (entry.selection === "default") {
        expect(exitCode).toBe(0);
        if (entry.json) {
          expect(JSON.parse(output)).toMatchObject({
            checksRun: 0,
            checksSkipped: 1,
            findings: [],
          });
        } else {
          expect(output).toContain("0 finding(s)");
          expect(output).toContain("  no findings\n");
        }
        expect(mocks.buildGatewayProbeConnectionDetails).not.toHaveBeenCalled();
        expect(mocks.callGateway).not.toHaveBeenCalled();
        return;
      }

      expect(exitCode).toBe(1);
      expect(output).toContain("core/doctor/gateway-health");
      expect(output).toContain("cold account:discord:ops");
      expect(output).toContain("channels.discord.accounts.ops.token");
      expect(output).toContain("openclaw secrets reload");
      expect(output).not.toContain("SYNTHETIC_GATEWAY_SECRET");
      expect(output).not.toContain("SYNTHETIC_OWNER_SECRET");
      expect(output).not.toContain("PRIVATE_REF_ID");
      expect(mocks.callGateway).toHaveBeenCalledOnce();
      if (entry.json) {
        expect(JSON.parse(output)).toMatchObject({
          ok: false,
          checksRun: 1,
          findings: [
            {
              checkId: "core/doctor/gateway-health",
              severity: "warning",
              path: "channels.discord.accounts.ops.token",
              target: "account:discord:ops",
            },
          ],
        });
      } else {
        expect(output).toContain("[warning] core/doctor/gateway-health");
      }
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
      stdout.mockRestore();
      registerChecks.mockRestore();
      resolveStateMode.mockRestore();
      if (previousResolveChecks) {
        mocks.resolveDoctorContributionHealthChecks.mockImplementation(previousResolveChecks);
      }
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

  it("reports an actionable Crabbox profile finding before dispatch", async () => {
    const binary = "/nonexistent/path/to/crabbox";
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        gateway: { mode: "local", port: 19_001 },
        cloudWorkers: {
          profiles: {
            aws: {
              provider: "crabbox",
              install: "bundle",
              settings: { provider: "aws", class: "standard", binary },
            },
          },
        },
      },
      path: "/tmp/openclaw.json",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      for (let run = 0; run < 2; run++) {
        const exitCode = await runDoctorLintCli(runtime, {
          json: true,
          onlyIds: [CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID],
        });
        expect(exitCode).toBe(1);
      }
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({
        ok: false,
        checksRun: 1,
        findings: [
          {
            checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
            severity: "warning",
            path: binary,
            target: "aws",
          },
        ],
      });
      expect(payload.findings[0].message).toContain('profile "aws"');
      expect(payload.findings[0].fixHint).toContain("cloudWorkers.profiles.aws.settings.binary");
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

  it("keeps mixed selected checks on a fully isolated state view", async () => {
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
    process.env.HOME = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    mocks.readConfigFileSnapshot.mockImplementation((...args: unknown[]) =>
      mocks.actualReadConfigFileSnapshot(...args),
    );
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
      restoreDoctorLintTestEnv(originalEnv);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("does not inspect plugin state when no semantic index exists", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-no-index-"));
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = {
      gateway: { mode: "local" },
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
    const originalEnv = {
      HOME: process.env.HOME,
      OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    };
    process.env.HOME = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    mocks.readConfigFileSnapshot.mockImplementation((...args: unknown[]) =>
      mocks.actualReadConfigFileSnapshot(...args),
    );
    mocks.prepareSqliteReadOnlyLocationSync.mockImplementationOnce(() => {
      throw new Error("shared state did not stabilize");
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runDoctorLintCli(runtime, {
          json: true,
          severityMin: "error",
          onlyIds: ["memory-core/managed-local-embedding-setup"],
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: true,
        checksRun: 1,
        findings: [],
      });
      expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mocks.prepareSqliteReadOnlyLocationSync).not.toHaveBeenCalled();
      expect(snapshotSqliteFamily(databasePath)).toEqual(before);
    } finally {
      stdout.mockRestore();
      restoreDoctorLintTestEnv(originalEnv);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("runs post-plugin readiness against an isolated state snapshot", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-relevant-"));
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = {
      gateway: { mode: "local" },
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
    clearLoadInstalledPluginIndexInstallRecordsCache();
    createSemanticIndex(stateDir);
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
      OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE,
    };
    process.env.HOME = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE = "1";
    mocks.readConfigFileSnapshot.mockImplementation((...args: unknown[]) =>
      mocks.actualReadConfigFileSnapshot(...args),
    );

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runDoctorLintCli(runtime, {
          json: true,
          severityMin: "error",
        }),
      ).resolves.toBe(1);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        checksRun: 1,
        findings: [
          {
            checkId: "memory-core/managed-local-embedding-setup",
            severity: "error",
            requirement: "managed-llama-cpp-setup",
          },
        ],
      });
      expect(sourceOpenStacks).toEqual([]);
      expect(snapshotSqliteFamily(databasePath)).toEqual(before);
    } finally {
      stdout.mockRestore();
      restoreDoctorLintTestEnv(originalEnv);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a semantic index needs plugin state that cannot be prepared", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-failure-"));
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = {
      gateway: { mode: "local" },
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
    const pluginDatabasePath = resolveOpenClawStateSqlitePath(env);
    closeOpenClawStateDatabaseByPath(pluginDatabasePath);
    createSemanticIndex(stateDir);
    const originalEnv = {
      HOME: process.env.HOME,
      OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    };
    process.env.HOME = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    mocks.readConfigFileSnapshot.mockImplementation((...args: unknown[]) =>
      mocks.actualReadConfigFileSnapshot(...args),
    );
    mocks.prepareSqliteReadOnlyLocationSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === pluginDatabasePath) {
        throw new Error("shared state did not stabilize");
      }
      return mocks.actualPrepareSqliteReadOnlyLocationSync(...args);
    });

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
        checksRun: 1,
        findings: [
          {
            checkId: "memory-core/managed-local-embedding-setup",
            severity: "error",
            target: "memory-core",
            requirement: "memory-index-inspection",
            message: expect.stringContaining("shared state did not stabilize"),
          },
        ],
      });
      expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mocks.prepareSqliteReadOnlyLocationSync).toHaveBeenCalledWith(pluginDatabasePath);
    } finally {
      stdout.mockRestore();
      restoreDoctorLintTestEnv(originalEnv);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("emits one structured failure when relevant plugin state cleanup does not complete", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-cleanup-"));
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = {
      gateway: { mode: "local" },
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
    const pluginDatabasePath = resolveOpenClawStateSqlitePath(env);
    closeOpenClawStateDatabaseByPath(pluginDatabasePath);
    createSemanticIndex(stateDir);
    const originalEnv = {
      HOME: process.env.HOME,
      OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    };
    process.env.HOME = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    mocks.readConfigFileSnapshot.mockImplementation((...args: unknown[]) =>
      mocks.actualReadConfigFileSnapshot(...args),
    );
    mocks.prepareSqliteReadOnlyLocationSync.mockImplementation((...args: unknown[]) => {
      const prepared = mocks.actualPrepareSqliteReadOnlyLocationSync(...args);
      if (args[0] !== pluginDatabasePath) {
        return prepared;
      }
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
        checksRun: 1,
        findings: [
          {
            checkId: "memory-core/managed-local-embedding-setup",
            severity: "error",
            target: "memory-core",
            requirement: "memory-index-inspection",
            message: expect.stringContaining("cleanup did not complete"),
          },
        ],
      });
    } finally {
      stdout.mockRestore();
      restoreDoctorLintTestEnv(originalEnv);
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

function createSemanticIndex(stateDir: string): string {
  const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  );
  database
    .prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)")
    .run("memory_index_meta_v1", JSON.stringify({ model: "embeddinggemma-300m", vectorDims: 768 }));
  database.close();
  return databasePath;
}

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

function restoreDoctorLintTestEnv(values: {
  HOME: string | undefined;
  OPENCLAW_CONFIG_PATH: string | undefined;
  OPENCLAW_STATE_DIR: string | undefined;
  OPENCLAW_UPDATE_POST_CORE_CONVERGENCE?: string | undefined;
}): void {
  if (values.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = values.HOME;
  }
  if (values.OPENCLAW_CONFIG_PATH === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = values.OPENCLAW_CONFIG_PATH;
  }
  if (values.OPENCLAW_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = values.OPENCLAW_STATE_DIR;
  }
  if (values.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE === undefined) {
    delete process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE;
  } else {
    process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE =
      values.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE;
  }
}

// Doctor lint tests cover health-check registry integration and lint warning output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import { resolveActivePluginInstallRoots } from "../plugins/install-root-context.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runDoctorLintCli } from "./doctor-lint.js";

const mocks = vi.hoisted(() => ({
  createConfigIO: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveDoctorContributionHealthChecks: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  mocks.createConfigIO.mockImplementation(actual.createConfigIO);
  return {
    ...actual,
    createConfigIO: (...args: unknown[]) => mocks.createConfigIO(...args),
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
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

  it("reads plugin state through a private snapshot without changing the source database", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-state-"));
    const stateDir = path.join(rootDir, "operator-state");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO fixture (value) VALUES ('stable');",
    );
    database.close();
    const sourcePluginInstallRoots = resolveActivePluginInstallRoots(process.env);
    const sourceContents = fs.readFileSync(databasePath);
    const sourceEntries = fs.readdirSync(path.dirname(databasePath)).toSorted();
    let configIoEnv: NodeJS.ProcessEnv | undefined;
    let observedPluginInstallRoots: ReturnType<typeof resolveActivePluginInstallRoots> | undefined;
    mocks.createConfigIO.mockImplementationOnce((options: { env?: NodeJS.ProcessEnv }) => {
      configIoEnv = options.env;
      return {
        readConfigFileSnapshot: () => mocks.readConfigFileSnapshot(),
      };
    });
    mocks.readConfigFileSnapshot.mockImplementation(async () => {
      observedPluginInstallRoots = resolveActivePluginInstallRoots(process.env);
      expect(observedPluginInstallRoots.stateDir).not.toBe(stateDir);
      expect(observedPluginInstallRoots.extensionsDir).toBe(sourcePluginInstallRoots.extensionsDir);
      expect(observedPluginInstallRoots.gitDir).toBe(sourcePluginInstallRoots.gitDir);
      expect(observedPluginInstallRoots.npmDir).toBe(sourcePluginInstallRoots.npmDir);
      expect(
        fs.existsSync(
          resolveOpenClawStateSqlitePath({
            ...process.env,
            OPENCLAW_STATE_DIR: observedPluginInstallRoots.stateDir,
          }),
        ),
      ).toBe(true);
      return {
        exists: true,
        valid: true,
        config: {},
        path: "/tmp/openclaw.json",
      };
    });
    registerHealthCheck({
      id: "plugin/example/read-only-state",
      kind: "plugin",
      description: "read-only state fixture",
      async detect(ctx) {
        expect(ctx.env?.OPENCLAW_STATE_DIR).toBe(stateDir);
        return [];
      },
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runDoctorLintCli(runtime, {
          json: true,
          onlyIds: ["plugin/example/read-only-state"],
        }),
      ).resolves.toBe(0);
      expect(observedPluginInstallRoots).toBeDefined();
      expect(configIoEnv?.OPENCLAW_STATE_DIR).toBe(observedPluginInstallRoots?.stateDir);
      expect(configIoEnv?.OPENCLAW_CONFIG_PATH).toBe(path.join(stateDir, "openclaw.json"));
      expect(resolveActivePluginInstallRoots(process.env)).toEqual(sourcePluginInstallRoots);
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetCoreHealthChecksForTest } from "../flows/doctor-core-checks.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { runDoctorLintCli } from "./doctor-lint.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("runDoctorLintCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHealthChecksForTest();
    resetCoreHealthChecksForTest();
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
        onlyIds: ["core/doctor/session-locks"],
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
            path: "core/doctor/session-locks",
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
      expect(payload.findings[0].fixHint).toContain("openclaw doctor --fix");
    } finally {
      stdout.mockRestore();
    }
  });

  it("rejects invalid severity thresholds", async () => {
    await expect(runDoctorLintCli(runtime, { severityMin: "warnng" })).rejects.toThrow(
      "Invalid --severity-min value",
    );
  });
});

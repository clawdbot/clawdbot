import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateRunResult } from "../infra/update-runner.js";

// Mock the update-runner module
vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(),
}));

vi.mock("../infra/clawdbot-root.js", () => ({
  resolveClawdbotPackageRoot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn(),
}));

vi.mock("../infra/update-check.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/update-check.js")>(
    "../infra/update-check.js",
  );
  return {
    ...actual,
    checkUpdateStatus: vi.fn(),
    fetchNpmTagVersion: vi.fn(),
  };
});

// Mock doctor (heavy module; should not run in unit tests)
vi.mock("../commands/doctor.js", () => ({
  doctorCommand: vi.fn(),
}));
// Mock the daemon-cli module
vi.mock("./daemon-cli.js", () => ({
  runDaemonRestart: vi.fn(),
}));

// Mock the runtime
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

describe("update-cli", () => {
  const baseSnapshot = {
    valid: true,
    config: {},
    issues: [],
  } as const;

  const setTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  };

  const setStdoutTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      configurable: true,
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { resolveClawdbotPackageRoot } = await import("../infra/clawdbot-root.js");
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const { checkUpdateStatus, fetchNpmTagVersion } = await import("../infra/update-check.js");
    vi.mocked(resolveClawdbotPackageRoot).mockResolvedValue(process.cwd());
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(baseSnapshot);
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/test/path",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root: "/test/path",
        sha: "abcdef1234567890",
        tag: "v1.2.3",
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 0,
        fetchOk: true,
      },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "/test/path/pnpm-lock.yaml",
        markerPath: "/test/path/node_modules",
      },
      registry: {
        latestVersion: "1.2.3",
      },
    });
    setTty(false);
    setStdoutTty(false);
  });

  it("exports updateCommand and registerUpdateCli", async () => {
    const { updateCommand, registerUpdateCli } = await import("./update-cli.js");
    expect(typeof updateCommand).toBe("function");
    expect(typeof registerUpdateCli).toBe("function");
  }, 20_000);

  it("updateCommand runs update and outputs result", async () => {
    const { runGatewayUpdate } = await import("../infra/update-runner.js");
    const { defaultRuntime } = await import("../runtime.js");
    const { updateCommand } = await import("./update-cli.js");

    const mockResult: UpdateRunResult = {
      status: "ok",
      mode: "git",
      root: "/test/path",
      before: { sha: "abc123", version: "1.0.0" },
      after: { sha: "def456", version: "1.0.1" },
      steps: [
        {
          name: "git fetch",
          command: "git fetch",
          cwd: "/test/path",
          durationMs: 100,
          exitCode: 0,
        },
      ],
      durationMs: 500,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);

    await updateCommand({ json: false });

    expect(runGatewayUpdate).toHaveBeenCalled();
    expect(defaultRuntime.log).toHaveBeenCalled();
  });

  it("updateStatusCommand prints table output", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    const { updateStatusCommand } = await import("./update-cli.js");

    await updateStatusCommand({ json: false });

    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => call[0]);
    expect(logs.join("\n")).toContain("Clawdbot update status");
  });

  it("updateStatusCommand emits JSON", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    const { updateStatusCommand } = await import("./update-cli.js");

    await updateStatusCommand({ json: true });

    const last = vi.mocked(defaultRuntime.log).mock.calls.at(-1)?.[0];
    expect(typeof last).toBe("string");
    const parsed = JSON.parse(String(last));
    expect(parsed.channel.value).toBe("stable");
  });

  it("defaults to dev channel for git installs when unset", async () => {
    const { runGatewayUpdate } = await import("../infra/update-runner.js");
    const { updateCommand } = await import("./update-cli.js");

    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
    });

    await updateCommand({});

    const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(call?.channel).toBe("dev");
  });

  it("defaults to stable channel for package installs when unset", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-update-"));
    try {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "clawdbot", version: "1.0.0" }),
        "utf-8",
      );

      const { resolveClawdbotPackageRoot } = await import("../infra/clawdbot-root.js");
      const { runGatewayUpdate } = await import("../infra/update-runner.js");
      const { updateCommand } = await import("./update-cli.js");

      vi.mocked(resolveClawdbotPackageRoot).mockResolvedValue(tempDir);
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "npm",
        steps: [],
        durationMs: 100,
      });

      await updateCommand({});

      const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
      expect(call?.channel).toBe("stable");
      expect(call?.tag).toBe("latest");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses stored beta channel when configured", async () => {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const { runGatewayUpdate } = await import("../infra/update-runner.js");
    const { updateCommand } = await import("./update-cli.js");

    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      config: { update: { channel: "beta" } },
    });
    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
    });

    await updateCommand({});

    const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(call?.channel).toBe("beta");
  });

  it("honors --tag override", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-update-"));
    try {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "clawdbot", version: "1.0.0" }),
        "utf-8",
      );

      const { resolveClawdbotPackageRoot } = await import("../infra/clawdbot-root.js");
      const { runGatewayUpdate } = await import("../infra/update-runner.js");
      const { updateCommand } = await import("./update-cli.js");

      vi.mocked(resolveClawdbotPackageRoot).mockResolvedValue(tempDir);
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "npm",
        steps: [],
        durationMs: 100,
      });

      await updateCommand({ tag: "next" });

      const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
      expect(call?.tag).toBe("next");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updateCommand outputs JSON when --json is set", async () => {
    const { runGatewayUpdate } = await import("../infra/update-runner.js");
    const { defaultRuntime } = await import("../runtime.js");
    const { updateCommand } = await import("./update-cli.js");

    const mockResult: UpdateRunResult = {
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);
    vi.mocked(defaultRuntime.log).mockClear();

    await updateCommand({ json: true });

    const logCalls = vi.mocked(defaultRuntime.log).mock.calls;
    const jsonOutput = logCalls.find((call) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
  });

  it("updateCommand exits with error on failure", async () => {
    const { runGatewayUpdate } = await import("../infra/update-runner.js");
    const { defaultRuntime } = await import("../runtime.js");
    const { updateCommand } = await import("./update-cli.js");

    const mockResult: UpdateRunResult = {
      status: "error",
      mode: "git",
      reason: "rebase-failed",
      steps: [],
      durationMs: 100,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);
    vi.mocked(defaultRuntime.exit).mockClear();

    await updateCommand({});

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("updateCommand restarts daemon when --restart is set", async () => {
    const { runGatewayUpdate } = await import("../infra/update-runner.js");
    const { runDaemonRestart } = await import("./daemon-cli.js");
    const { updateCommand } = await import("./update-cli.js");

    const mockResult: UpdateRunResult = {
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);

    await updateCommand({ restart: true });

    expect(runDaemonRestart).toHaveBeenCalled();
  });

  it("updateCommand skips success message when restart does not run", async () => {
    const { runGatewayUpdate } = await import("../infra/update-runner.js");
    const { runDaemonRestart } = await import("./daemon-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const { updateCommand } = await import("./update-cli.js");

    const mockResult: UpdateRunResult = {
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);
    vi.mocked(runDaemonRestart).mockResolvedValue(false);
    vi.mocked(defaultRuntime.log).mockClear();

    await updateCommand({ restart: true });

    const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logLines.some((line) => line.includes("Daemon restarted successfully."))).toBe(false);
  });

  it("updateCommand validates timeout option", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    const { updateCommand } = await import("./update-cli.js");

    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    await updateCommand({ timeout: "invalid" });

    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("persists update channel when --channel is set", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    const { runGatewayUpdate } = await import("../infra/update-runner.js");
    const { updateCommand } = await import("./update-cli.js");

    const mockResult: UpdateRunResult = {
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);

    await updateCommand({ channel: "beta" });

    expect(writeConfigFile).toHaveBeenCalled();
    const call = vi.mocked(writeConfigFile).mock.calls[0]?.[0] as {
      update?: { channel?: string };
    };
    expect(call?.update?.channel).toBe("beta");
  });

  it("requires confirmation on downgrade when non-interactive", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-update-"));
    try {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "clawdbot", version: "2.0.0" }),
        "utf-8",
      );

      const { resolveClawdbotPackageRoot } = await import("../infra/clawdbot-root.js");
      const { fetchNpmTagVersion } = await import("../infra/update-check.js");
      const { runGatewayUpdate } = await import("../infra/update-runner.js");
      const { defaultRuntime } = await import("../runtime.js");
      const { updateCommand } = await import("./update-cli.js");

      vi.mocked(resolveClawdbotPackageRoot).mockResolvedValue(tempDir);
      vi.mocked(fetchNpmTagVersion).mockResolvedValue({
        tag: "latest",
        version: "0.0.1",
      });
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "npm",
        steps: [],
        durationMs: 100,
      });
      vi.mocked(defaultRuntime.error).mockClear();
      vi.mocked(defaultRuntime.exit).mockClear();

      await updateCommand({});

      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("Downgrade confirmation required."),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

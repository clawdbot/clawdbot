import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateRunResult } from "../infra/update-runner.js";

const confirm = vi.fn();
const select = vi.fn();
const spinner = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
const isCancel = (value: unknown) => value === "cancel";

vi.mock("@clack/prompts", () => ({
  confirm,
  select,
  isCancel,
  spinner,
}));

// Mock the update-runner module
vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(),
}));

vi.mock("../infra/moltbot-root.js", () => ({
  resolveMoltbotPackageRoot: vi.fn(),
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
    resolveNpmChannelTag: vi.fn(),
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

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
    const { resolveMoltbotPackageRoot } = await import("../infra/moltbot-root.js");
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const { checkUpdateStatus, fetchNpmTagVersion, resolveNpmChannelTag } =
      await import("../infra/update-check.js");
    const { runCommandWithTimeout } = await import("../process/exec.js");
    vi.mocked(resolveMoltbotPackageRoot).mockResolvedValue(process.cwd());
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(baseSnapshot);
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
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
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });
    setTty(false);
    setStdoutTty(false);
  });

  it("exports updateCommand and registerUpdateCli", async () => {
    const { updateCommand, registerUpdateCli, updateWizardCommand } =
      await import("./update-cli.js");
    expect(typeof updateCommand).toBe("function");
    expect(typeof registerUpdateCli).toBe("function");
    expect(typeof updateWizardCommand).toBe("function");
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
    expect(logs.join("\n")).toContain("Moltbot update status");
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
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-update-"));
    try {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "moltbot", version: "1.0.0" }),
        "utf-8",
      );

      const { resolveMoltbotPackageRoot } = await import("../infra/moltbot-root.js");
      const { runGatewayUpdate } = await import("../infra/update-runner.js");
      const { checkUpdateStatus } = await import("../infra/update-check.js");
      const { updateCommand } = await import("./update-cli.js");

      vi.mocked(resolveMoltbotPackageRoot).mockResolvedValue(tempDir);
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: tempDir,
        installKind: "package",
        packageManager: "npm",
        deps: {
          manager: "npm",
          status: "ok",
          lockfilePath: null,
          markerPath: null,
        },
      });
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "npm",
        steps: [],
        durationMs: 100,
      });

      await updateCommand({ yes: true });

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

  it("falls back to latest when beta tag is older than release", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-update-"));
    try {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "moltbot", version: "1.0.0" }),
        "utf-8",
      );

      const { resolveMoltbotPackageRoot } = await import("../infra/moltbot-root.js");
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const { resolveNpmChannelTag } = await import("../infra/update-check.js");
      const { runGatewayUpdate } = await import("../infra/update-runner.js");
      const { updateCommand } = await import("./update-cli.js");
      const { checkUpdateStatus } = await import("../infra/update-check.js");

      vi.mocked(resolveMoltbotPackageRoot).mockResolvedValue(tempDir);
      vi.mocked(readConfigFileSnapshot).mockResolvedValue({
        ...baseSnapshot,
        config: { update: { channel: "beta" } },
      });
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: tempDir,
        installKind: "package",
        packageManager: "npm",
        deps: {
          manager: "npm",
          status: "ok",
          lockfilePath: null,
          markerPath: null,
        },
      });
      vi.mocked(resolveNpmChannelTag).mockResolvedValue({
        tag: "latest",
        version: "1.2.3-1",
      });
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "npm",
        steps: [],
        durationMs: 100,
      });

      await updateCommand({});

      const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
      expect(call?.channel).toBe("beta");
      expect(call?.tag).toBe("latest");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("honors --tag override", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-update-"));
    try {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "moltbot", version: "1.0.0" }),
        "utf-8",
      );

      const { resolveMoltbotPackageRoot } = await import("../infra/moltbot-root.js");
      const { runGatewayUpdate } = await import("../infra/update-runner.js");
      const { updateCommand } = await import("./update-cli.js");

      vi.mocked(resolveMoltbotPackageRoot).mockResolvedValue(tempDir);
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

  it("updateCommand restarts daemon by default", async () => {
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

    await updateCommand({});

    expect(runDaemonRestart).toHaveBeenCalled();
  });

  it("updateCommand skips restart when --no-restart is set", async () => {
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

    await updateCommand({ restart: false });

    expect(runDaemonRestart).not.toHaveBeenCalled();
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
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-update-"));
    try {
      setTty(false);
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "moltbot", version: "2.0.0" }),
        "utf-8",
      );

      const { resolveMoltbotPackageRoot } = await import("../infra/moltbot-root.js");
      const { resolveNpmChannelTag } = await import("../infra/update-check.js");
      const { runGatewayUpdate } = await import("../infra/update-runner.js");
      const { defaultRuntime } = await import("../runtime.js");
      const { updateCommand } = await import("./update-cli.js");
      const { checkUpdateStatus } = await import("../infra/update-check.js");

      vi.mocked(resolveMoltbotPackageRoot).mockResolvedValue(tempDir);
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: tempDir,
        installKind: "package",
        packageManager: "npm",
        deps: {
          manager: "npm",
          status: "ok",
          lockfilePath: null,
          markerPath: null,
        },
      });
      vi.mocked(resolveNpmChannelTag).mockResolvedValue({
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

  it("allows downgrade with --yes in non-interactive mode", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-update-"));
    try {
      setTty(false);
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "moltbot", version: "2.0.0" }),
        "utf-8",
      );

      const { resolveMoltbotPackageRoot } = await import("../infra/moltbot-root.js");
      const { resolveNpmChannelTag } = await import("../infra/update-check.js");
      const { runGatewayUpdate } = await import("../infra/update-runner.js");
      const { defaultRuntime } = await import("../runtime.js");
      const { updateCommand } = await import("./update-cli.js");
      const { checkUpdateStatus } = await import("../infra/update-check.js");

      vi.mocked(resolveMoltbotPackageRoot).mockResolvedValue(tempDir);
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: tempDir,
        installKind: "package",
        packageManager: "npm",
        deps: {
          manager: "npm",
          status: "ok",
          lockfilePath: null,
          markerPath: null,
        },
      });
      vi.mocked(resolveNpmChannelTag).mockResolvedValue({
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

      await updateCommand({ yes: true });

      expect(defaultRuntime.error).not.toHaveBeenCalledWith(
        expect.stringContaining("Downgrade confirmation required."),
      );
      expect(runGatewayUpdate).toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updateWizardCommand requires a TTY", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    const { updateWizardCommand } = await import("./update-cli.js");

    setTty(false);
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    await updateWizardCommand({});

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Update wizard requires a TTY"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("updateWizardCommand offers dev checkout and forwards selections", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-update-wizard-"));
    const previousGitDir = process.env.CLAWDBOT_GIT_DIR;
    try {
      setTty(true);
      process.env.CLAWDBOT_GIT_DIR = tempDir;

      const { checkUpdateStatus } = await import("../infra/update-check.js");
      const { runGatewayUpdate } = await import("../infra/update-runner.js");
      const { updateWizardCommand } = await import("./update-cli.js");

      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: "/test/path",
        installKind: "package",
        packageManager: "npm",
        deps: {
          manager: "npm",
          status: "ok",
          lockfilePath: null,
          markerPath: null,
        },
      });
      select.mockResolvedValue("dev");
      confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "git",
        steps: [],
        durationMs: 100,
      });

      await updateWizardCommand({});

      const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
      expect(call?.channel).toBe("dev");
    } finally {
      process.env.CLAWDBOT_GIT_DIR = previousGitDir;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

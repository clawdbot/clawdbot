import { describe, expect, it, vi } from "vitest";

import type { UpdateRunResult } from "../infra/update-runner.js";

// Mock the update-runner module
vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(),
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
  it("exports updateCommand and registerUpdateCli", async () => {
    const { updateCommand, registerUpdateCli } = await import(
      "./update-cli.js"
    );
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

    const logLines = vi
      .mocked(defaultRuntime.log)
      .mock.calls.map((call) => String(call[0]));
    expect(
      logLines.some((line) => line.includes("Daemon restarted successfully.")),
    ).toBe(false);
  });

  it("updateCommand validates timeout option", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    const { updateCommand } = await import("./update-cli.js");

    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    await updateCommand({ timeout: "invalid" });

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("timeout"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});

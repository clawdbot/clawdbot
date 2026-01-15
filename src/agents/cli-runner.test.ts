import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCliAgent } from "./cli-runner.js";

const runCommandWithTimeoutMock = vi.fn();
const runExecMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

describe("runCliAgent resume cleanup", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    runExecMock.mockReset();
  });

  it("kills stale resume processes for codex sessions", async () => {
    // First call is for cleanupSuspendedCliProcesses (returns count 0)
    // Second call is for cleanupResumeProcesses (pkill)
    runExecMock.mockResolvedValue({ stdout: "0", stderr: "" });
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-1",
      cliSessionId: "thread-123",
    });

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    // First call: cleanupSuspendedCliProcesses (bash to count)
    // Second call: cleanupResumeProcesses (pkill)
    expect(runExecMock).toHaveBeenCalledTimes(2);

    // Verify the pkill call for resume cleanup
    const pkillCall = runExecMock.mock.calls[1] ?? [];
    expect(pkillCall[0]).toBe("pkill");
    const pkillArgs = pkillCall[1] as string[];
    expect(pkillArgs[0]).toBe("-f");
    expect(pkillArgs[1]).toContain("codex");
    expect(pkillArgs[1]).toContain("resume");
    expect(pkillArgs[1]).toContain("thread-123");
  });

  it("cleans up suspended processes when threshold exceeded", async () => {
    // Return count > 10 to trigger cleanup
    runExecMock
      .mockResolvedValueOnce({ stdout: "15", stderr: "" }) // count suspended
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // kill command
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    // cleanupSuspendedCliProcesses: count + kill (2 calls)
    // cleanupResumeProcesses: not called for claude-cli (no resumeArgs)
    expect(runExecMock).toHaveBeenCalledTimes(2);

    // First call: count suspended processes
    const countCall = runExecMock.mock.calls[0] ?? [];
    expect(countCall[0]).toBe("bash");

    // Second call: kill suspended processes
    const killCall = runExecMock.mock.calls[1] ?? [];
    expect(killCall[0]).toBe("bash");
  });
});

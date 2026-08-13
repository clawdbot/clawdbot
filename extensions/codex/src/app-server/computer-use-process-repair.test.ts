// Codex tests cover bounded, fail-closed Computer Use process repair.
import { afterEach, describe, expect, it, vi } from "vitest";

const runExecMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runExec: runExecMock,
}));

import { killStaleComputerUseMcpChildren } from "./computer-use-process-repair.js";

describe("Codex Computer Use process repair", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runExecMock.mockReset();
  });

  it("bounds process inspection and never signals from an incomplete snapshot", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    runExecMock.mockRejectedValueOnce(new Error("process listing timed out"));
    const killSpy = vi.spyOn(process, "kill");

    const result = await killStaleComputerUseMcpChildren({ ancestorPid: 42 });

    expect(runExecMock).toHaveBeenCalledWith("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      logOutput: false,
      maxBuffer: 5 * 1024 * 1024,
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({
      attempted: true,
      killedPids: [],
      message: "Computer Use stale child repair could not inspect running processes.",
    });
    expect(result.warnings).toEqual([
      expect.stringContaining("Could not list processes for Computer Use repair"),
    ]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("signals only matching descendants from a complete process snapshot", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    runExecMock.mockResolvedValueOnce({
      stdout: [
        "  42     1 /Applications/ChatGPT.app/Contents/Resources/codex app-server",
        " 100    42 /usr/bin/node SkyComputerUseClient mcp --stdio",
        " 101    42 /usr/bin/node unrelated-helper",
        " 102    99 /usr/bin/node SkyComputerUseClient mcp --stdio",
        "  99     1 /usr/bin/other-parent",
        "",
      ].join("\n"),
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await killStaleComputerUseMcpChildren({ ancestorPid: 42 });

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(100, "SIGTERM");
    expect(result).toMatchObject({ attempted: true, killedPids: [100], warnings: [] });
  });

  it("does not inspect processes without a scoped local app-server pid", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    const result = await killStaleComputerUseMcpChildren({ ancestorPid: 0 });

    expect(result.attempted).toBe(false);
    expect(result.killedPids).toEqual([]);
    expect(runExecMock).not.toHaveBeenCalled();
  });

  it("does not inspect processes on unsupported platforms", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    const result = await killStaleComputerUseMcpChildren({ ancestorPid: 42 });

    expect(result).toMatchObject({ attempted: true, killedPids: [] });
    expect(result.warnings).toEqual([
      "Computer Use stale child repair is currently macOS-only, not linux.",
    ]);
    expect(runExecMock).not.toHaveBeenCalled();
  });
});

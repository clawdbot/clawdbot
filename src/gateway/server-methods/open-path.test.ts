import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runExecMock, spawnCommandMock } = vi.hoisted(() => ({
  runExecMock: vi.fn(),
  spawnCommandMock: vi.fn(),
}));

vi.mock("../../process/exec.js", () => ({
  runExec: runExecMock,
  spawnCommand: spawnCommandMock,
}));

import { execOpenPath, resolveOpenPathCommand } from "./open-path.js";

function fakeChild(result: Promise<unknown>) {
  const unref = vi.fn();
  const kill = vi.fn();
  const stderr = new PassThrough();
  return {
    child: Object.assign(result, { kill, stderr, unref }),
    kill,
    stderr,
    unref,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("resolveOpenPathCommand", () => {
  it("uses open on macOS", () => {
    expect(resolveOpenPathCommand("/tmp/openclaw.json", "darwin")).toEqual({
      command: "open",
      args: ["/tmp/openclaw.json"],
    });
  });

  it("uses xdg-open on Linux", () => {
    expect(resolveOpenPathCommand("/tmp/openclaw.json", "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/openclaw.json"],
    });
  });

  it("uses a quoted PowerShell FilePath on Windows", () => {
    expect(resolveOpenPathCommand(String.raw`C:\tmp\o'hai & calc.json`, "win32")).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`Start-Process -FilePath 'C:\tmp\o''hai & calc.json'`,
      ],
    });
  });
});

describe("execOpenPath", () => {
  it.each(["darwin", "win32"] as const)("bounds the %s launcher wait", async (platform) => {
    runExecMock.mockResolvedValue({ stdout: "", stderr: "" });
    const command = {
      command: platform === "darwin" ? "open" : "powershell.exe",
      args: ["/tmp/workspace"],
    };

    await execOpenPath(command, platform);

    expect(runExecMock).toHaveBeenCalledWith(command.command, command.args, {
      logOutput: false,
      timeoutMs: 5_000,
    });
  });

  it("detaches xdg-open and preserves an immediate successful exit", async () => {
    const spawned = fakeChild(Promise.resolve({ failed: false }));
    spawnCommandMock.mockReturnValue(spawned.child);

    await execOpenPath({ command: "xdg-open", args: ["/tmp/workspace"] }, "linux");

    expect(spawnCommandMock).toHaveBeenCalledWith(["xdg-open", "/tmp/workspace"], {
      buffer: false,
      cleanup: false,
      detached: true,
      reject: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(spawned.unref).toHaveBeenCalledOnce();
  });

  it("returns after startup observation without killing a foreground Linux handler", async () => {
    vi.useFakeTimers();
    let settleChild: (value: unknown) => void = () => {};
    const childResult = new Promise<unknown>((resolve) => {
      settleChild = resolve;
    });
    const spawned = fakeChild(childResult);
    spawnCommandMock.mockReturnValue(spawned.child);
    let settled = false;

    const execution = execOpenPath({ command: "xdg-open", args: ["/tmp/workspace"] }, "linux").then(
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await execution;

    expect(settled).toBe(true);
    expect(spawned.kill).not.toHaveBeenCalled();
    expect(spawned.stderr.destroyed).toBe(false);
    expect(spawned.stderr.write("foreground handler: delayed diagnostic")).toBe(true);
    settleChild({ failed: false });
    await Promise.resolve();
    expect(spawned.stderr.destroyed).toBe(true);
  });

  it("propagates an immediate Linux launcher failure with bounded stderr", async () => {
    let rejectChild: (error: Error) => void = () => {};
    const spawned = fakeChild(
      new Promise((_, reject) => {
        rejectChild = reject;
      }),
    );
    spawnCommandMock.mockReturnValue(spawned.child);

    const execution = execOpenPath({ command: "xdg-open", args: ["/tmp/workspace"] }, "linux");
    spawned.stderr.write("xdg-open: no method available for opening '/tmp/workspace'");
    rejectChild(new Error("Command failed with exit code 3: xdg-open"));

    await expect(execution).rejects.toThrow("xdg-open: no method available");
  });

  it("keeps xdg-open stderr truncation surrogate-safe", async () => {
    let rejectChild: (error: Error) => void = () => {};
    const spawned = fakeChild(
      new Promise((_, reject) => {
        rejectChild = reject;
      }),
    );
    spawnCommandMock.mockReturnValue(spawned.child);

    const execution = execOpenPath({ command: "xdg-open", args: ["/tmp/workspace"] }, "linux");
    // 4095 ASCII chars plus one emoji: a plain slice for the final slot would
    // keep only the emoji's high surrogate half.
    spawned.stderr.write(`${"x".repeat(4095)}🤖`);
    rejectChild(new Error("Command failed with exit code 3: xdg-open"));

    const message = await execution.then(
      () => {
        throw new Error("expected rejection");
      },
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const expectedMessage = `Command failed with exit code 3: xdg-open: ${"x".repeat(4_095)}`;
    expect(message).toBe(expectedMessage);
    expect(message).toHaveLength(expectedMessage.length);
  });
});

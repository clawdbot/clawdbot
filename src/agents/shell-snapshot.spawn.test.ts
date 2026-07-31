import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { maybeWrapCommandWithShellSnapshot } from "./shell-snapshot.js";

const { killProcessTreeMock, spawnMock } = vi.hoisted(() => ({
  killProcessTreeMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: spawnMock },
  );
});

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

describe.skipIf(process.platform === "win32")("shell snapshot subprocesses", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["HOME", "OPENCLAW_EXEC_SHELL_SNAPSHOT", "OPENCLAW_STATE_DIR"]);
    spawnMock.mockReset();
    killProcessTreeMock.mockReset();
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("does not create output pipes for status-only shell commands", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242 }) as ChildProcess;
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", 1));
      return child;
    });

    const home = tempDirs.make("openclaw-snapshot-spawn-home-");
    const stateDir = tempDirs.make("openclaw-snapshot-spawn-state-");
    setTestEnvValue("HOME", home);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    const command = "echo unchanged";
    await expect(
      maybeWrapCommandWithShellSnapshot({
        command,
        shell: "/bin/bash",
        shellArgs: ["-c"],
        cwd: os.tmpdir(),
        env: { ...process.env },
      }),
    ).resolves.toBe(command);

    const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
    expect(options?.stdio).toBe("ignore");
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242, { graceMs: 0, detached: true });
  });
});

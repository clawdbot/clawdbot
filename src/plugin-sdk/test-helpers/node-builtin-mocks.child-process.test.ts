/**
 * Tests child_process behavior in the shared Node builtin mock helpers.
 */
import { describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("./node-builtin-mocks.js");
  return mockNodeChildProcessSpawnSync(spawnSyncMock);
});

const childProcess = await import("node:child_process");

describe("mockNodeChildProcessSpawnSync", () => {
  it("can build a child_process mock from inside its own Vitest mock factory", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "ok" });

    expect(childProcess.spawnSync("node", ["--version"])).toEqual({ status: 0, stdout: "ok" });
    expect(spawnSyncMock).toHaveBeenCalledWith("node", ["--version"]);
  });

  it("preserves untargeted child_process exports", () => {
    expect(typeof childProcess.execFileSync).toBe("function");
  });
});

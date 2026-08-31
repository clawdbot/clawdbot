import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", () => ({ spawnSync: childProcessMocks.spawnSync }));

import { handleZoomMeetingsNodeHostCommand } from "./node-host.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  childProcessMocks.spawnSync.mockReset();
});

describe("Zoom meetings node setup", () => {
  it("shares one timeout across the sequential device and command probes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    childProcessMocks.spawnSync.mockImplementation(() => {
      const call = childProcessMocks.spawnSync.mock.calls.length;
      if (call === 1) {
        vi.setSystemTime(6_000);
        return { status: 0, stderr: "", stdout: "BlackHole 2ch" };
      }
      vi.setSystemTime(call === 2 ? 8_000 : 9_000);
      return { status: 0, stderr: "", stdout: "" };
    });

    await handleZoomMeetingsNodeHostCommand(
      JSON.stringify({
        action: "setup",
        audioInputCommand: ["sox"],
        audioOutputCommand: ["play"],
      }),
    );

    expect(
      childProcessMocks.spawnSync.mock.calls.map(
        (call) => (call[2] as { timeout?: number } | undefined)?.timeout,
      ),
    ).toEqual([10_000, 4_000, 2_000]);
  });

  it("reports a timed-out command probe separately from a missing command", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const timeoutError = Object.assign(new Error("spawnSync /bin/sh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    childProcessMocks.spawnSync
      .mockReturnValueOnce({ status: 0, stderr: "", stdout: "BlackHole 2ch" })
      .mockReturnValueOnce({ status: null, stderr: "", stdout: "", error: timeoutError });

    await expect(
      handleZoomMeetingsNodeHostCommand(
        JSON.stringify({
          action: "setup",
          audioInputCommand: ["sox"],
          audioOutputCommand: ["play"],
        }),
      ),
    ).rejects.toThrow("Zoom meeting audio prerequisite check timed out on the node.");

    expect(childProcessMocks.spawnSync).toHaveBeenCalledTimes(2);
  });
});

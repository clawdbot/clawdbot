import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", () => ({ spawnSync: childProcessMocks.spawnSync }));

import { handleZoomMeetingsNodeHostCommand } from "./node-host.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

let handleTeamsMeetingsNodeHostCommand: typeof import("./node-host.js").handleTeamsMeetingsNodeHostCommand;

const successfulProbe = {
  pid: 123,
  output: [null, "BlackHole 2ch", ""],
  stdout: "BlackHole 2ch",
  stderr: "",
  status: 0,
  signal: null,
  error: undefined,
};

function setupParams() {
  return JSON.stringify({
    action: "setup",
    audioInputCommand: ["capture"],
    audioOutputCommand: ["play"],
  });
}

describe("Teams meeting node-host prerequisite deadline", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawnSync: spawnSyncMock };
    });
    ({ handleTeamsMeetingsNodeHostCommand } = await import("./node-host.js"));
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue(successfulProbe);
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.restoreAllMocks();
  });

  it("shares one timeout budget across every prerequisite probe", async () => {
    const now = vi.spyOn(Date, "now");
    for (const value of [1_000, 1_000, 4_000, 8_000]) {
      now.mockReturnValueOnce(value);
    }

    await expect(handleTeamsMeetingsNodeHostCommand(setupParams())).resolves.toBe(
      JSON.stringify({
        ok: true,
        audioBackend: "blackhole-2ch",
        audioDeviceLabel: "BlackHole 2ch",
      }),
    );

    expect(
      spawnSyncMock.mock.calls.map((call) => (call[2] as { timeout?: number }).timeout),
    ).toEqual([10_000, 7_000, 3_000]);
  });

  it("does not start another probe after the shared deadline expires", async () => {
    const now = vi.spyOn(Date, "now");
    for (const value of [1_000, 1_000, 11_000]) {
      now.mockReturnValueOnce(value);
    }

    await expect(handleTeamsMeetingsNodeHostCommand(setupParams())).rejects.toThrow(
      "Microsoft Teams meeting audio prerequisite check timed out on the node.",
    );
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("reports a timed-out profiler separately from a missing audio device", async () => {
    const timeoutError = Object.assign(new Error("spawnSync system_profiler ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    spawnSyncMock.mockReturnValueOnce({
      ...successfulProbe,
      status: null,
      stdout: "",
      error: timeoutError,
    });

    await expect(handleTeamsMeetingsNodeHostCommand(setupParams())).rejects.toThrow(
      "Microsoft Teams meeting audio prerequisite check timed out on the node.",
    );
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});

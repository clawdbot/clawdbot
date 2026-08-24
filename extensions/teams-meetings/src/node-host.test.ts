import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

let teamsMeetingsConfig: (typeof import("./config.js"))["teamsMeetingsConfig"];
let handleTeamsMeetingsNodeHostCommand: (typeof import("./node-host.js"))["handleTeamsMeetingsNodeHostCommand"];

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
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue(successfulProbe);
    ({ teamsMeetingsConfig } = await import("./config.js"));
    ({ handleTeamsMeetingsNodeHostCommand } = await import("./node-host.js"));
  });

  afterEach(() => {
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

  it("probes the default sox executable only once", async () => {
    await expect(
      handleTeamsMeetingsNodeHostCommand(
        JSON.stringify({
          action: "setup",
          audioInputCommand: teamsMeetingsConfig.defaultAudioInputCommand,
          audioOutputCommand: teamsMeetingsConfig.defaultAudioOutputCommand,
        }),
      ),
    ).resolves.toBe(
      JSON.stringify({
        ok: true,
        audioBackend: "blackhole-2ch",
        audioDeviceLabel: "BlackHole 2ch",
      }),
    );

    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock.mock.calls[1]?.[1]).toEqual([
      "-lc",
      'command -v "$1" >/dev/null 2>&1',
      "sh",
      "sox",
    ]);
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

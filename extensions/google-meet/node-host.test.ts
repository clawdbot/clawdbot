import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

type MockChild = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  stdout?: EventEmitter;
  stderr?: EventEmitter;
  stdin?: { write: ReturnType<typeof vi.fn> };
};

const children: MockChild[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      status: 0,
      stdout: "BlackHole 2ch",
      stderr: "",
    })),
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill: vi.fn((signal?: NodeJS.Signals) => {
          child.signalCode = signal ?? "SIGTERM";
          return true;
        }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { write: vi.fn() },
      }) as MockChild;
      children.push(child);
      return child;
    }),
  };
});

describe("google-meet node host bridge sessions", () => {
  afterEach(() => {
    vi.useRealTimers();
    children.length = 0;
  });

  afterAll(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("starts observe-only Chrome without BlackHole or bridge processes", async () => {
    const { handleGoogleMeetNodeHostCommand } = await import("./src/node-host.js");
    const originalPlatform = process.platform;
    children.length = 0;
    vi.mocked(spawnSync).mockClear();

    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      const start = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "start",
            url: "https://meet.google.com/xyz-abcd-uvw",
            mode: "transcribe",
            launch: false,
            audioInputCommand: ["mock-rec"],
            audioOutputCommand: ["mock-play"],
          }),
        ),
      );

      expect(start).toEqual({ launched: false });
      expect(spawnSync).not.toHaveBeenCalled();
      expect(children).toHaveLength(0);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("clears output playback without closing the active bridge when the old output exits", async () => {
    const { handleGoogleMeetNodeHostCommand } = await import("./src/node-host.js");
    const originalPlatform = process.platform;
    children.length = 0;

    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      const start = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "start",
            url: "https://meet.google.com/xyz-abcd-uvw",
            mode: "realtime",
            launch: false,
            audioInputCommand: ["mock-rec"],
            audioOutputCommand: ["mock-play"],
          }),
        ),
      );

      expect(children).toHaveLength(2);
      const firstOutput = children[0];

      const cleared = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "clearAudio",
            bridgeId: start.bridgeId,
          }),
        ),
      );

      expect(cleared).toEqual({ bridgeId: start.bridgeId, ok: true, clearCount: 1 });
      expect(children).toHaveLength(3);
      expect(firstOutput?.kill).toHaveBeenCalledWith("SIGTERM");

      firstOutput?.emit("error", new Error("stale output failed after clear"));
      firstOutput?.emit("exit", 0, "SIGTERM");

      const status = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "status",
            bridgeId: start.bridgeId,
          }),
        ),
      );

      expect(status.bridge.bridgeId).toBe(start.bridgeId);
      expect(status.bridge.closed).toBe(false);
      expect(status.bridge.clearCount).toBe(1);
      expect(typeof status.bridge.createdAt).toBe("string");

      const audio = Buffer.from([1, 2, 3]);
      await handleGoogleMeetNodeHostCommand(
        JSON.stringify({
          action: "pushAudio",
          bridgeId: start.bridgeId,
          base64: audio.toString("base64"),
        }),
      );

      expect(children[2]?.stdin?.write).toHaveBeenCalledWith(audio);
      expect(firstOutput?.stdin?.write).not.toHaveBeenCalled();

      await handleGoogleMeetNodeHostCommand(
        JSON.stringify({
          action: "stop",
          bridgeId: start.bridgeId,
        }),
      );
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("lists active bridge sessions and hides closed sessions", async () => {
    const { handleGoogleMeetNodeHostCommand } = await import("./src/node-host.js");
    const originalPlatform = process.platform;
    children.length = 0;

    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      const start = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "start",
            url: "https://meet.google.com/abc-defg-hij?authuser=1",
            mode: "realtime",
            launch: false,
            audioInputCommand: ["mock-rec"],
            audioOutputCommand: ["mock-play"],
          }),
        ),
      );

      expect(typeof start.bridgeId).toBe("string");
      expect(start.bridgeId.length).toBeGreaterThan(0);
      expect(start).toEqual({
        audioBridge: { type: "node-command-pair" },
        bridgeId: start.bridgeId,
        launched: false,
      });

      const activeList = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "list",
            url: "https://meet.google.com/abc-defg-hij",
            mode: "realtime",
          }),
        ),
      );

      expect(activeList.bridges).toHaveLength(1);
      expect(activeList.bridges[0]?.bridgeId).toBe(start.bridgeId);
      expect(activeList.bridges[0]?.closed).toBe(false);
      expect(activeList.bridges[0]?.mode).toBe("realtime");
      expect(activeList.bridges[0]?.url).toBe("https://meet.google.com/abc-defg-hij?authuser=1");
      expect(typeof activeList.bridges[0]?.createdAt).toBe("string");

      children[1]?.emit("exit", 0, null);

      const afterExitList = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "list",
            url: "https://meet.google.com/abc-defg-hij",
            mode: "realtime",
          }),
        ),
      );

      expect(afterExitList).toEqual({ bridges: [] });

      const stopped = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "stopByUrl",
            url: "https://meet.google.com/abc-defg-hij",
            mode: "realtime",
          }),
        ),
      );

      expect(stopped).toEqual({ ok: true, stopped: 0 });
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });
});

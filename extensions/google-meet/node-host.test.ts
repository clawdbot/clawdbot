// Google Meet tests cover node host plugin behavior.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type MockChild = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  ignoreSigterm: boolean;
  kill: ReturnType<typeof vi.fn>;
  stdout?: EventEmitter;
  stderr?: EventEmitter;
  stdin?: EventEmitter & { write: ReturnType<typeof vi.fn> };
};

const children: MockChild[] = [];
let handleGoogleMeetNodeHostCommand: typeof import("./src/node-host.js").handleGoogleMeetNodeHostCommand;

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
        ignoreSigterm: false,
        kill: vi.fn(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
      }) as MockChild;
      child.kill.mockImplementation((signal?: NodeJS.Signals) => {
        const resolvedSignal = signal ?? "SIGTERM";
        if (resolvedSignal === "SIGTERM" && child.ignoreSigterm) {
          return true;
        }
        queueMicrotask(() => {
          child.signalCode = resolvedSignal;
          child.emit("exit", null, resolvedSignal);
        });
        return true;
      });
      children.push(child);
      return child;
    }),
  };
});

describe("google-meet node host bridge sessions", () => {
  beforeAll(async () => {
    ({ handleGoogleMeetNodeHostCommand } = await import("./src/node-host.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    children.length = 0;
  });

  afterAll(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("reports malformed params JSON with an owned error", async () => {
    await expect(handleGoogleMeetNodeHostCommand("{not json")).rejects.toThrow(
      "Google Meet node host received malformed params JSON.",
    );
  });

  it("rejects non-Meet start URLs before local Chrome side effects", async () => {
    const originalPlatform = process.platform;
    children.length = 0;
    vi.mocked(spawnSync).mockClear();

    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      await expect(
        handleGoogleMeetNodeHostCommand(
          JSON.stringify({
            action: "start",
            url: "https://example.com/private-call",
            mode: "realtime",
            launch: true,
            audioInputCommand: ["mock-rec"],
            audioOutputCommand: ["mock-play"],
          }),
        ),
      ).rejects.toThrow("url must be an explicit https://meet.google.com/... URL");

      expect(spawnSync).not.toHaveBeenCalled();
      expect(children).toHaveLength(0);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("starts observe-only Chrome without BlackHole or bridge processes", async () => {
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

  it("passes the Meet URL before Chrome profile args when launching a profiled browser", async () => {
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
            browserProfile: "Profile 2",
          }),
        ),
      );

      expect(start.launched).toBe(true);
      expect(spawnSync).toHaveBeenCalledWith(
        "open",
        [
          "-a",
          "Google Chrome",
          "https://meet.google.com/xyz-abcd-uvw",
          "--args",
          "--profile-directory=Profile 2",
        ],
        expect.objectContaining({ encoding: "utf8" }),
      );
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("clears output playback without closing the active bridge when the old output exits", async () => {
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

  it("waits for cleared SIGTERM-resistant output before acknowledging stop", async () => {
    const originalPlatform = process.platform;
    children.length = 0;
    vi.useFakeTimers();

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
      const [retiredOutput] = children;
      if (!retiredOutput) {
        throw new Error("expected Google Meet node host output process");
      }
      retiredOutput.ignoreSigterm = true;

      await handleGoogleMeetNodeHostCommand(
        JSON.stringify({ action: "clearAudio", bridgeId: start.bridgeId }),
      );
      let settled = false;
      const stopPromise = handleGoogleMeetNodeHostCommand(
        JSON.stringify({ action: "stop", bridgeId: start.bridgeId }),
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      expect(retiredOutput.kill.mock.calls).toEqual([["SIGTERM"]]);

      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;
      expect(retiredOutput.signalCode).toBe("SIGKILL");
      expect(retiredOutput.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("closes once when command-pair streams fail together", async () => {
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
      const [outputProcess, inputProcess] = children;
      if (!outputProcess || !inputProcess) {
        throw new Error("expected Google Meet node host command-pair processes");
      }

      outputProcess.stderr?.emit("error", new Error("output stderr failed"));
      inputProcess.stdout?.emit("error", new Error("input stdout failed"));
      inputProcess.stderr?.emit("error", new Error("input stderr failed"));

      const status = JSON.parse(
        await handleGoogleMeetNodeHostCommand(
          JSON.stringify({ action: "status", bridgeId: start.bridgeId }),
        ),
      );
      expect(status.bridge.closed).toBe(true);
      expect(outputProcess.kill).toHaveBeenCalledTimes(1);
      expect(inputProcess.kill).toHaveBeenCalledTimes(1);
      expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
      expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("waits for SIGTERM-resistant command-pair processes before acknowledging stop", async () => {
    const originalPlatform = process.platform;
    children.length = 0;
    vi.useFakeTimers();

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
      const [outputProcess, inputProcess] = children;
      if (!outputProcess || !inputProcess) {
        throw new Error("expected Google Meet node host command-pair processes");
      }
      outputProcess.ignoreSigterm = true;
      inputProcess.ignoreSigterm = true;
      let settled = false;
      const stopPromise = handleGoogleMeetNodeHostCommand(
        JSON.stringify({ action: "stop", bridgeId: start.bridgeId }),
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
      expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;
      expect(outputProcess.signalCode).toBe("SIGKILL");
      expect(inputProcess.signalCode).toBe("SIGKILL");
      expect(outputProcess.kill).toHaveBeenCalledWith("SIGKILL");
      expect(inputProcess.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("shares SIGTERM-resistant cleanup across concurrent stopByUrl calls", async () => {
    const originalPlatform = process.platform;
    children.length = 0;
    vi.useFakeTimers();

    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      await handleGoogleMeetNodeHostCommand(
        JSON.stringify({
          action: "start",
          url: "https://meet.google.com/xyz-abcd-uvw",
          mode: "realtime",
          launch: false,
          audioInputCommand: ["mock-rec"],
          audioOutputCommand: ["mock-play"],
        }),
      );
      const [outputProcess, inputProcess] = children;
      if (!outputProcess || !inputProcess) {
        throw new Error("expected Google Meet node host command-pair processes");
      }
      outputProcess.ignoreSigterm = true;
      inputProcess.ignoreSigterm = true;
      let firstSettled = false;
      let secondSettled = false;
      const stopParams = JSON.stringify({
        action: "stopByUrl",
        url: "https://meet.google.com/xyz-abcd-uvw",
        mode: "realtime",
      });
      const firstStop = handleGoogleMeetNodeHostCommand(stopParams).finally(() => {
        firstSettled = true;
      });
      const secondStop = handleGoogleMeetNodeHostCommand(stopParams).finally(() => {
        secondSettled = true;
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const [firstResult, secondResult] = await Promise.all([firstStop, secondStop]);
      expect(JSON.parse(firstResult)).toEqual({ ok: true, stopped: 1 });
      expect(JSON.parse(secondResult)).toEqual({ ok: true, stopped: 0 });
      expect(outputProcess.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(inputProcess.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("lists active bridge sessions and hides closed sessions", async () => {
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

      if (children[1]) {
        children[1].exitCode = 0;
        children[1].emit("exit", 0, null);
      }

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

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));
const cryptoMocks = vi.hoisted(() => ({
  randomUUID: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcessMocks.spawn,
  spawnSync: childProcessMocks.spawnSync,
}));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: cryptoMocks.randomUUID,
}));

import { createMeetingNodeHost, type MeetingNodeHostOptions } from "./node-host.js";

const TEST_UUID = "00000000-0000-4000-8000-000000000001";
// Mirrors the node-host's private retention limits.
const MAX_QUEUED_INPUT_CHUNKS = 200;
const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;
const AUDIO_START_PARAMS = {
  action: "start",
  audioInputCommand: ["capture"],
  audioOutputCommand: ["play"],
  mode: "bidi",
} as const;

type TestStdin = EventEmitter & {
  accept: () => void;
  write: ReturnType<typeof vi.fn>;
};

function createStdin(writeResult: boolean): TestStdin {
  const stdin = new EventEmitter() as TestStdin;
  const callbacks: Array<(error?: Error | null) => void> = [];
  stdin.write = vi.fn((_audio: Buffer, callback?: (error?: Error | null) => void) => {
    if (callback) {
      if (writeResult) {
        queueMicrotask(() => callback());
      } else {
        callbacks.push(callback);
      }
    }
    return writeResult;
  });
  stdin.accept = () => {
    for (const callback of callbacks.splice(0)) {
      callback();
    }
  };
  return stdin;
}

function createProcess(params: {
  stdin?: TestStdin | null;
  stdout?: EventEmitter | null;
  autoClose?: boolean;
}) {
  const events = new EventEmitter();
  const proc = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: params.stdin ?? null,
    stdout: params.stdout ?? null,
    stderr: new EventEmitter(),
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      proc.signalCode = signal;
      queueMicrotask(() => {
        events.emit("exit", null, signal);
        if (params.autoClose !== false) {
          params.stdout?.emit("end");
          params.stdout?.emit("close");
          events.emit("close", null, signal);
        }
      });
      return true;
    }),
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    emit: events.emit.bind(events),
  };
  return proc;
}

function createHost(overrides: Partial<MeetingNodeHostOptions> = {}) {
  return createMeetingNodeHost({
    agentMode: "agent",
    assertAudioAvailable: vi.fn(),
    bridgeIdPrefix: "test-bridge-",
    browser: {
      application: "Test Browser",
      buildProfileArgs: () => [],
      openedNotes: [],
      openedStatus: "opened",
    },
    browserLabel: "Test Browser",
    commandName: "meeting.chrome",
    defaultAudioInputCommand: ["capture"],
    defaultAudioOutputCommand: ["play"],
    displayName: "Test Meeting",
    normalizeMeetingKey: (url) => url,
    normalizeUrl: (input) => (typeof input === "string" ? input : "https://meeting.test"),
    talkBackModes: new Set(["bidi"]),
    ...overrides,
  });
}

async function invokeHost(
  host: ReturnType<typeof createHost>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return JSON.parse(await host.handleCommand(JSON.stringify(params))) as Record<string, unknown>;
}

async function startAudioBridge(
  options: { inputAutoClose?: boolean; outputStdin?: TestStdin } = {},
) {
  const inputStdout = new EventEmitter();
  const inputProcess = createProcess({ stdout: inputStdout, autoClose: options.inputAutoClose });
  const outputStdin = options.outputStdin ?? createStdin(true);
  const outputProcess = createProcess({ stdin: outputStdin });
  childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
  const host = createHost();
  const started = await invokeHost(host, { ...AUDIO_START_PARAMS, launch: false });
  return {
    bridgeId: started.bridgeId as string,
    host,
    inputProcess,
    inputStdout,
    outputProcess,
    outputStdin,
  };
}

function invokeBridge(
  bridge: Awaited<ReturnType<typeof startAudioBridge>>,
  action: "clearAudio" | "pullAudio" | "pushAudio" | "status" | "stop",
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return invokeHost(bridge.host, { action, bridgeId: bridge.bridgeId, ...params });
}

describe("meeting node host audio backend", () => {
  beforeEach(() => {
    cryptoMocks.randomUUID.mockReturnValue(TEST_UUID);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("prepares the node-local backend and uses its generated command pair", async () => {
    const inputProcess = createProcess({ stdout: new EventEmitter() });
    const outputProcess = createProcess({ stdin: createStdin(true) });
    childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    const prepareAudio = vi.fn(async () => ({
      backend: "pipewire-pulse" as const,
      deviceLabel: "OpenClaw Meeting Audio",
      inputCommand: ["parec", "--device", "input name", ""],
      outputCommand: ["pacat", "--device", "output name", ""],
    }));
    const host = createHost({ prepareAudio });

    const started = await invokeHost(host, {
      action: "start",
      url: "https://meeting.test/linux",
      mode: "bidi",
      launch: false,
      audioBackend: "auto",
      audioBufferBytes: 2_048,
      audioFormat: "g711-ulaw-8khz",
      audioInputCommand: ["trusted-capture"],
      audioOutputCommand: ["trusted-playback"],
    });

    expect(prepareAudio).toHaveBeenCalledWith(
      {
        backend: "auto",
        bufferBytes: 2_048,
        format: "g711-ulaw-8khz",
        inputCommand: ["trusted-capture"],
        outputCommand: ["trusted-playback"],
        bargeInInputCommand: undefined,
      },
      10_000,
    );
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      1,
      "pacat",
      ["--device", "output name", ""],
      {
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      2,
      "parec",
      ["--device", "input name", ""],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(started).toMatchObject({
      audioBackend: "pipewire-pulse",
      audioDeviceLabel: "OpenClaw Meeting Audio",
      audioBridge: { type: "node-command-pair" },
    });
    await invokeHost(host, { action: "stop", bridgeId: started.bridgeId });
  });

  it("provisions audio before preserving the configured external bridge path", async () => {
    const events: string[] = [];
    const prepareAudio = vi.fn(async () => {
      events.push("prepare");
      return {
        backend: "pipewire-pulse" as const,
        deviceLabel: "OpenClaw Meeting Audio",
        inputCommand: ["parec"],
        outputCommand: ["pacat"],
      };
    });
    childProcessMocks.spawnSync.mockImplementation(() => {
      events.push("bridge");
      return { error: undefined, signal: null, status: 0, stderr: "", stdout: "" };
    });
    const host = createHost({ prepareAudio });

    const started = await invokeHost(host, {
      action: "start",
      url: "https://meeting.test/external",
      mode: "bidi",
      launch: false,
      audioBridgeCommand: ["trusted-bridge", "start"],
    });

    expect(events).toEqual(["prepare", "bridge"]);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    expect(started).toMatchObject({
      audioBackend: "pipewire-pulse",
      audioBridge: { type: "external-command" },
    });
  });

  it("returns the concrete backend from setup without starting bridge processes", async () => {
    const prepareAudio = vi.fn(async () => ({
      backend: "pipewire-pulse" as const,
      deviceLabel: "OpenClaw Meeting Audio",
      inputCommand: ["parec"],
      outputCommand: ["pacat"],
    }));
    const host = createHost({ prepareAudio });

    await expect(
      invokeHost(host, {
        action: "setup",
        audioBackend: "auto",
        audioBufferBytes: 4_096,
        audioFormat: "pcm16-24khz",
      }),
    ).resolves.toEqual({
      ok: true,
      audioBackend: "pipewire-pulse",
      audioDeviceLabel: "OpenClaw Meeting Audio",
    });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    { name: "input", inputCommand: [], outputCommand: ["play"] },
    { name: "output", inputCommand: ["capture"], outputCommand: [] },
  ])("rejects an empty $name command before spawning", async ({ inputCommand, outputCommand }) => {
    const host = createHost({
      prepareAudio: vi.fn(async () => ({
        backend: "pipewire-pulse" as const,
        deviceLabel: "OpenClaw Meeting Audio",
        inputCommand,
        outputCommand,
      })),
    });

    await expect(invokeHost(host, { ...AUDIO_START_PARAMS, launch: false })).rejects.toThrow(
      "audio command must not be empty",
    );
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });
});

describe("meeting node host audio output", () => {
  beforeEach(() => {
    cryptoMocks.randomUUID.mockReturnValue(TEST_UUID);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("copies retained input buffers", async () => {
    const bridge = await startAudioBridge();
    const source = Buffer.from([1, 2, 3]);

    bridge.inputStdout.emit("data", source);
    source.fill(9);

    const pulled = await invokeBridge(bridge, "pullAudio");
    expect(Buffer.from(pulled.base64 as string, "base64")).toEqual(Buffer.from([1, 2, 3]));
    await invokeBridge(bridge, "stop");
  });

  it("keeps only the newest bounded input chunks", async () => {
    const bridge = await startAudioBridge();

    for (let value = 0; value <= MAX_QUEUED_INPUT_CHUNKS; value += 1) {
      bridge.inputStdout.emit("data", Buffer.from([value]));
    }

    const status = await invokeBridge(bridge, "status");
    expect((status.bridge as Record<string, unknown>).queuedInputChunks).toBe(
      MAX_QUEUED_INPUT_CHUNKS,
    );
    const pulled = await invokeBridge(bridge, "pullAudio");
    expect(Buffer.from(pulled.base64 as string, "base64")).toEqual(Buffer.from([1]));
    await invokeBridge(bridge, "stop");
  });

  it("keeps only the newest bounded input bytes", async () => {
    const bridge = await startAudioBridge();
    const chunkBytes = 64 * 1024;

    for (let value = 0; value <= MAX_QUEUED_INPUT_BYTES / chunkBytes; value += 1) {
      bridge.inputStdout.emit("data", Buffer.alloc(chunkBytes, value));
    }

    const status = await invokeBridge(bridge, "status");
    expect((status.bridge as Record<string, unknown>).queuedInputChunks).toBe(
      MAX_QUEUED_INPUT_BYTES / chunkBytes,
    );
    const pulled = await invokeBridge(bridge, "pullAudio");
    expect(Buffer.from(pulled.base64 as string, "base64")).toEqual(Buffer.alloc(chunkBytes, 1));
    await invokeBridge(bridge, "stop");
  });

  it("copies only the newest bytes from an oversized input chunk", async () => {
    const bridge = await startAudioBridge();
    const source = Buffer.allocUnsafe(MAX_QUEUED_INPUT_BYTES + 4);
    for (let index = 0; index < source.length; index += 1) {
      source[index] = index % 251;
    }
    const expected = Buffer.from(source.subarray(source.length - MAX_QUEUED_INPUT_BYTES));

    bridge.inputStdout.emit("data", source);
    source.fill(0);

    const pulled = await invokeBridge(bridge, "pullAudio");
    expect(Buffer.from(pulled.base64 as string, "base64")).toEqual(expected);
    await invokeBridge(bridge, "stop");
  });

  it("delivers terminal close to an outstanding pull and then deletes the session", async () => {
    const bridge = await startAudioBridge();
    const { bridgeId } = bridge;
    const pulling = invokeBridge(bridge, "pullAudio", { timeoutMs: 2_000 });

    bridge.inputProcess.stderr.emit("error", new Error("capture failed"));

    await expect(pulling).resolves.toEqual({ bridgeId, closed: true });
    await vi.waitFor(async () => {
      await expect(invokeBridge(bridge, "status")).resolves.toEqual({
        bridge: { bridgeId, closed: true },
      });
    });
    await expect(invokeBridge(bridge, "pullAudio")).rejects.toThrow(
      `unknown bridgeId: ${bridgeId}`,
    );
    expect(bridge.outputProcess.kill).toHaveBeenCalledTimes(1);
    expect(bridge.inputProcess.kill).toHaveBeenCalledTimes(1);
  });

  it("delivers final audio before terminal close deletes the session", async () => {
    const bridge = await startAudioBridge();
    const { bridgeId } = bridge;
    const pulling = invokeBridge(bridge, "pullAudio", { timeoutMs: 2_000 });
    const finalAudio = Buffer.from([1, 2, 3]);

    bridge.inputStdout.emit("data", finalAudio);
    bridge.inputProcess.stderr.emit("error", new Error("capture failed"));

    await expect(pulling).resolves.toEqual({
      bridgeId,
      closed: true,
      base64: finalAudio.toString("base64"),
    });
    await vi.waitFor(async () => {
      await expect(invokeBridge(bridge, "pullAudio")).rejects.toThrow(
        `unknown bridgeId: ${bridgeId}`,
      );
    });
  });

  it("delivers stdout flushed after 250ms to a pending empty pull", async () => {
    vi.useFakeTimers();
    try {
      const bridge = await startAudioBridge({ inputAutoClose: false });
      const { bridgeId } = bridge;
      const finalAudio = Buffer.from([7, 8, 9]);
      const pulling = invokeBridge(bridge, "pullAudio", { timeoutMs: 2_000 });

      bridge.inputProcess.stderr.emit("error", new Error("capture failed"));
      await vi.advanceTimersByTimeAsync(300);
      bridge.inputStdout.emit("data", finalAudio);
      bridge.inputStdout.emit("end");
      bridge.inputStdout.emit("close");

      await expect(pulling).resolves.toEqual({
        bridgeId,
        closed: true,
        base64: finalAudio.toString("base64"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks output commands as soon as terminal teardown starts", async () => {
    const bridge = await startAudioBridge({
      inputAutoClose: false,
      outputStdin: createStdin(false),
    });
    const { bridgeId } = bridge;
    const pushing = invokeBridge(bridge, "pushAudio", {
      base64: Buffer.from([1, 2, 3]).toString("base64"),
      outputGeneration: 0,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    bridge.inputProcess.stderr.emit("error", new Error("capture failed"));

    await expect(pushing).resolves.toEqual({ bridgeId, ok: true, stale: true });
    await expect(
      invokeBridge(bridge, "pushAudio", {
        base64: Buffer.from([4, 5, 6]).toString("base64"),
        outputGeneration: 0,
      }),
    ).rejects.toThrow(`bridge is not open: ${bridgeId}`);
    await expect(invokeBridge(bridge, "clearAudio", { outputGeneration: 1 })).rejects.toThrow(
      `bridge is not open: ${bridgeId}`,
    );
    await expect(invokeBridge(bridge, "status")).resolves.toMatchObject({
      bridge: { bridgeId, closed: true },
    });
    await expect(
      invokeHost(bridge.host, {
        action: "list",
        url: "https://meeting.test",
        mode: "bidi",
      }),
    ).resolves.toEqual({ bridges: [] });
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);

    bridge.inputStdout.emit("end");
    bridge.inputStdout.emit("close");
    await expect(invokeBridge(bridge, "stop")).resolves.toEqual({
      ok: true,
      stopped: false,
    });
  });

  it("drains final audio when input closes between sequential pulls", async () => {
    const bridge = await startAudioBridge();
    const { bridgeId } = bridge;
    const firstAudio = Buffer.from([1, 2, 3]);
    const finalAudio = Buffer.from([4, 5, 6]);

    bridge.inputStdout.emit("data", firstAudio);
    bridge.inputStdout.emit("data", finalAudio);
    bridge.inputProcess.stderr.emit("error", new Error("capture failed"));
    await Promise.resolve();

    await expect(invokeBridge(bridge, "pullAudio")).resolves.toEqual({
      bridgeId,
      closed: false,
      base64: firstAudio.toString("base64"),
    });
    await expect(invokeBridge(bridge, "pullAudio")).resolves.toEqual({
      bridgeId,
      closed: true,
      base64: finalAudio.toString("base64"),
    });
    await vi.waitFor(async () => {
      await expect(invokeBridge(bridge, "pullAudio")).rejects.toThrow(
        `unknown bridgeId: ${bridgeId}`,
      );
    });
  });

  it("starts terminal eviction after capture drain becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const bridge = await startAudioBridge({ inputAutoClose: false });
      const { bridgeId } = bridge;

      const firstAudio = Buffer.from([1, 2, 3]);
      const finalAudio = Buffer.from([4, 5, 6]);
      bridge.inputStdout.emit("data", firstAudio);
      bridge.inputStdout.emit("data", finalAudio);
      bridge.inputProcess.stderr.emit("error", new Error("capture failed"));
      await expect(invokeBridge(bridge, "pullAudio")).resolves.toEqual({
        bridgeId,
        closed: false,
        base64: firstAudio.toString("base64"),
      });

      await vi.advanceTimersByTimeAsync(3_000);
      bridge.inputStdout.emit("end");
      bridge.inputStdout.emit("close");
      await vi.advanceTimersByTimeAsync(2_100);

      await expect(invokeBridge(bridge, "status")).resolves.toMatchObject({
        bridge: { bridgeId, closed: true, queuedInputChunks: 1 },
      });
      await vi.advanceTimersByTimeAsync(2_899);
      await expect(invokeBridge(bridge, "status")).resolves.toMatchObject({
        bridge: { bridgeId, closed: true, queuedInputChunks: 1 },
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(invokeBridge(bridge, "pullAudio")).rejects.toThrow(
        `unknown bridgeId: ${bridgeId}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps terminal audio while pull progress continues", async () => {
    vi.useFakeTimers();
    try {
      const bridge = await startAudioBridge();
      const { bridgeId } = bridge;
      const firstAudio = Buffer.from([1, 2, 3]);
      const finalAudio = Buffer.from([4, 5, 6]);

      bridge.inputStdout.emit("data", firstAudio);
      bridge.inputStdout.emit("data", finalAudio);
      bridge.inputProcess.stderr.emit("error", new Error("capture failed"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(invokeBridge(bridge, "pullAudio")).resolves.toEqual({
        bridgeId,
        closed: false,
        base64: firstAudio.toString("base64"),
      });
      await vi.advanceTimersByTimeAsync(4_999);
      await expect(invokeBridge(bridge, "status")).resolves.toMatchObject({
        bridge: { bridgeId, closed: true, queuedInputChunks: 1 },
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(invokeBridge(bridge, "pullAudio")).rejects.toThrow(
        `unknown bridgeId: ${bridgeId}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears and deletes input retention on explicit stop", async () => {
    const bridge = await startAudioBridge();
    const { bridgeId } = bridge;
    bridge.inputStdout.emit("data", Buffer.alloc(64 * 1024));

    await expect(invokeBridge(bridge, "stop")).resolves.toEqual({
      ok: true,
      stopped: true,
    });
    await expect(invokeBridge(bridge, "stop")).resolves.toEqual({
      ok: true,
      stopped: false,
    });
    await expect(invokeBridge(bridge, "pullAudio")).rejects.toThrow(
      `unknown bridgeId: ${bridgeId}`,
    );
  });

  it("terminates output when input process construction throws", async () => {
    const outputProcess = createProcess({ stdin: createStdin(true) });
    const spawnError = new Error("input spawn failed");
    childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockImplementationOnce(() => {
      throw spawnError;
    });
    const host = createHost();

    await expect(invokeHost(host, { ...AUDIO_START_PARAMS, launch: false })).rejects.toBe(
      spawnError,
    );
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("deletes a hidden audio session after browser launch fails", async () => {
    const inputProcess = createProcess({ stdout: new EventEmitter() });
    const outputProcess = createProcess({ stdin: createStdin(true) });
    childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    childProcessMocks.spawnSync.mockReturnValue({
      error: undefined,
      signal: null,
      status: 1,
      stderr: "launch failed",
      stdout: "",
    });
    const host = createHost();
    const bridgeId = `test-bridge-${TEST_UUID}`;

    await expect(invokeHost(host, AUDIO_START_PARAMS)).rejects.toThrow(
      "failed to launch Chrome for Test Browser: launch failed",
    );
    await vi.waitFor(async () => {
      await expect(invokeHost(host, { action: "status", bridgeId })).resolves.toEqual({
        bridge: { bridgeId, closed: true },
      });
    });
    await expect(invokeHost(host, { action: "pullAudio", bridgeId })).rejects.toThrow(
      `unknown bridgeId: ${bridgeId}`,
    );
  });

  it("deletes a hidden audio session when browser launch throws", async () => {
    const inputProcess = createProcess({ stdout: new EventEmitter() });
    const outputProcess = createProcess({ stdin: createStdin(true) });
    const launchError = new Error("browser launch threw");
    childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    childProcessMocks.spawnSync.mockImplementationOnce(() => {
      throw launchError;
    });
    const host = createHost();
    const bridgeId = `test-bridge-${TEST_UUID}`;

    await expect(invokeHost(host, AUDIO_START_PARAMS)).rejects.toBe(launchError);
    await vi.waitFor(async () => {
      await expect(invokeHost(host, { action: "pullAudio", bridgeId })).rejects.toThrow(
        `unknown bridgeId: ${bridgeId}`,
      );
    });
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("waits for the output stream to accept a backpressured chunk", async () => {
    const bridge = await startAudioBridge({ outputStdin: createStdin(false) });
    const { outputStdin } = bridge;

    let settled = false;
    const pushing = invokeBridge(bridge, "pushAudio", {
      base64: Buffer.from([1, 2, 3]).toString("base64"),
      outputGeneration: 0,
    }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);

    outputStdin.accept();
    await expect(pushing).resolves.toMatchObject({ ok: true });
    await invokeBridge(bridge, "stop");
  });

  it("rejects output generations outside the safe integer range", async () => {
    const bridge = await startAudioBridge();

    await expect(
      invokeBridge(bridge, "clearAudio", {
        outputGeneration: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("outputGeneration must be a non-negative integer");
    await invokeBridge(bridge, "stop");
  });

  it("waits for output acceptance and rejects stale generations after clear", async () => {
    const replacementStdin = createStdin(true);
    const bridge = await startAudioBridge({ outputStdin: createStdin(false) });
    childProcessMocks.spawn.mockReturnValueOnce(createProcess({ stdin: replacementStdin }));
    const { bridgeId } = bridge;
    expect(typeof bridgeId).toBe("string");

    let firstPushSettled = false;
    const firstPush = invokeBridge(bridge, "pushAudio", {
      base64: Buffer.from([1, 2, 3]).toString("base64"),
      outputGeneration: 0,
    }).then((result) => {
      firstPushSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(firstPushSettled).toBe(false);

    const cleared = await invokeBridge(bridge, "clearAudio", {
      outputGeneration: 1,
    });
    expect(cleared).toMatchObject({ ok: true });
    await expect(firstPush).resolves.toMatchObject({
      ok: true,
      stale: true,
    });

    const stalePush = await invokeBridge(bridge, "pushAudio", {
      base64: Buffer.from([4, 5, 6]).toString("base64"),
      outputGeneration: 0,
    });
    expect(stalePush).toMatchObject({ ok: true, stale: true });
    expect(replacementStdin.write).not.toHaveBeenCalled();

    await invokeBridge(bridge, "stop");
  });

  it("accepts legacy output commands and preserves their response shapes", async () => {
    const replacementStdin = createStdin(true);
    const bridge = await startAudioBridge();
    childProcessMocks.spawn.mockReturnValueOnce(createProcess({ stdin: replacementStdin }));
    const { bridgeId } = bridge;

    await expect(
      invokeBridge(bridge, "pushAudio", {
        base64: Buffer.from([1, 2, 3]).toString("base64"),
      }),
    ).resolves.toEqual({ bridgeId, ok: true });
    await expect(invokeBridge(bridge, "clearAudio")).resolves.toEqual({
      bridgeId,
      ok: true,
      clearCount: 1,
    });
    await expect(
      invokeBridge(bridge, "pushAudio", {
        base64: Buffer.from([4, 5, 6]).toString("base64"),
      }),
    ).resolves.toEqual({ bridgeId, ok: true });
    expect(bridge.outputStdin.write).toHaveBeenCalledOnce();
    expect(replacementStdin.write).toHaveBeenCalledOnce();

    await invokeBridge(bridge, "stop");
  });
});

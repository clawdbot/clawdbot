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

import { createMeetingNodeHost } from "./node-host.js";

const TEST_UUID = "00000000-0000-4000-8000-000000000001";
// Mirrors the node-host's private retention limits.
const MAX_QUEUED_INPUT_CHUNKS = 200;
const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;

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

function createHost() {
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
  });
}

async function invokeHost(
  host: ReturnType<typeof createHost>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return JSON.parse(await host.handleCommand(JSON.stringify(params))) as Record<string, unknown>;
}

describe("meeting node host audio output", () => {
  beforeEach(() => {
    cryptoMocks.randomUUID.mockReturnValue(TEST_UUID);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("copies retained input buffers", async () => {
    const inputStdout = new EventEmitter();
    childProcessMocks.spawn
      .mockReturnValueOnce(createProcess({ stdin: createStdin(true) }))
      .mockReturnValueOnce(createProcess({ stdout: inputStdout }));
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const source = Buffer.from([1, 2, 3]);

    inputStdout.emit("data", source);
    source.fill(9);

    const pulled = await invokeHost(host, {
      action: "pullAudio",
      bridgeId: started.bridgeId,
    });
    expect(Buffer.from(pulled.base64 as string, "base64")).toEqual(Buffer.from([1, 2, 3]));
    await invokeHost(host, { action: "stop", bridgeId: started.bridgeId });
  });

  it("keeps only the newest bounded input chunks", async () => {
    const inputStdout = new EventEmitter();
    childProcessMocks.spawn
      .mockReturnValueOnce(createProcess({ stdin: createStdin(true) }))
      .mockReturnValueOnce(createProcess({ stdout: inputStdout }));
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });

    for (let value = 0; value <= MAX_QUEUED_INPUT_CHUNKS; value += 1) {
      inputStdout.emit("data", Buffer.from([value]));
    }

    const status = await invokeHost(host, {
      action: "status",
      bridgeId: started.bridgeId,
    });
    expect((status.bridge as Record<string, unknown>).queuedInputChunks).toBe(
      MAX_QUEUED_INPUT_CHUNKS,
    );
    const pulled = await invokeHost(host, {
      action: "pullAudio",
      bridgeId: started.bridgeId,
    });
    expect(Buffer.from(pulled.base64 as string, "base64")).toEqual(Buffer.from([1]));
    await invokeHost(host, { action: "stop", bridgeId: started.bridgeId });
  });

  it("keeps only the newest bounded input bytes", async () => {
    const inputStdout = new EventEmitter();
    childProcessMocks.spawn
      .mockReturnValueOnce(createProcess({ stdin: createStdin(true) }))
      .mockReturnValueOnce(createProcess({ stdout: inputStdout }));
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const chunkBytes = 64 * 1024;

    for (let value = 0; value <= MAX_QUEUED_INPUT_BYTES / chunkBytes; value += 1) {
      inputStdout.emit("data", Buffer.alloc(chunkBytes, value));
    }

    const status = await invokeHost(host, {
      action: "status",
      bridgeId: started.bridgeId,
    });
    expect((status.bridge as Record<string, unknown>).queuedInputChunks).toBe(
      MAX_QUEUED_INPUT_BYTES / chunkBytes,
    );
    const pulled = await invokeHost(host, {
      action: "pullAudio",
      bridgeId: started.bridgeId,
    });
    expect(Buffer.from(pulled.base64 as string, "base64")).toEqual(Buffer.alloc(chunkBytes, 1));
    await invokeHost(host, { action: "stop", bridgeId: started.bridgeId });
  });

  it("copies only the newest bytes from an oversized input chunk", async () => {
    const inputStdout = new EventEmitter();
    childProcessMocks.spawn
      .mockReturnValueOnce(createProcess({ stdin: createStdin(true) }))
      .mockReturnValueOnce(createProcess({ stdout: inputStdout }));
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const source = Buffer.allocUnsafe(MAX_QUEUED_INPUT_BYTES + 4);
    for (let index = 0; index < source.length; index += 1) {
      source[index] = index % 251;
    }
    const expected = Buffer.from(source.subarray(source.length - MAX_QUEUED_INPUT_BYTES));

    inputStdout.emit("data", source);
    source.fill(0);

    const pulled = await invokeHost(host, {
      action: "pullAudio",
      bridgeId: started.bridgeId,
    });
    expect(Buffer.from(pulled.base64 as string, "base64")).toEqual(expected);
    await invokeHost(host, { action: "stop", bridgeId: started.bridgeId });
  });

  it("delivers terminal close to an outstanding pull and then deletes the session", async () => {
    const inputStdout = new EventEmitter();
    const inputProcess = createProcess({ stdout: inputStdout });
    const outputProcess = createProcess({ stdin: createStdin(true) });
    childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const bridgeId = started.bridgeId as string;
    const pulling = invokeHost(host, {
      action: "pullAudio",
      bridgeId,
      timeoutMs: 2_000,
    });

    inputProcess.stderr.emit("error", new Error("capture failed"));

    await expect(pulling).resolves.toEqual({ bridgeId, closed: true });
    await vi.waitFor(async () => {
      await expect(invokeHost(host, { action: "status", bridgeId })).resolves.toEqual({
        bridge: { bridgeId, closed: true },
      });
    });
    await expect(invokeHost(host, { action: "pullAudio", bridgeId })).rejects.toThrow(
      `unknown bridgeId: ${bridgeId}`,
    );
    expect(outputProcess.kill).toHaveBeenCalledTimes(1);
    expect(inputProcess.kill).toHaveBeenCalledTimes(1);
  });

  it("delivers final audio before terminal close deletes the session", async () => {
    const inputStdout = new EventEmitter();
    const inputProcess = createProcess({ stdout: inputStdout });
    const outputProcess = createProcess({ stdin: createStdin(true) });
    childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const bridgeId = started.bridgeId as string;
    const pulling = invokeHost(host, {
      action: "pullAudio",
      bridgeId,
      timeoutMs: 2_000,
    });
    const finalAudio = Buffer.from([1, 2, 3]);

    inputStdout.emit("data", finalAudio);
    inputProcess.stderr.emit("error", new Error("capture failed"));

    await expect(pulling).resolves.toEqual({
      bridgeId,
      closed: true,
      base64: finalAudio.toString("base64"),
    });
    await vi.waitFor(async () => {
      await expect(invokeHost(host, { action: "pullAudio", bridgeId })).rejects.toThrow(
        `unknown bridgeId: ${bridgeId}`,
      );
    });
  });

  it("delivers stdout flushed after 250ms to a pending empty pull", async () => {
    vi.useFakeTimers();
    try {
      const inputStdout = new EventEmitter();
      const inputProcess = createProcess({ stdout: inputStdout, autoClose: false });
      const outputProcess = createProcess({ stdin: createStdin(true) });
      childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
      const host = createHost();
      const started = await invokeHost(host, {
        action: "start",
        audioInputCommand: ["capture"],
        audioOutputCommand: ["play"],
        launch: false,
        mode: "bidi",
      });
      const bridgeId = started.bridgeId as string;
      const finalAudio = Buffer.from([7, 8, 9]);
      const pulling = invokeHost(host, {
        action: "pullAudio",
        bridgeId,
        timeoutMs: 2_000,
      });

      inputProcess.stderr.emit("error", new Error("capture failed"));
      await vi.advanceTimersByTimeAsync(300);
      inputStdout.emit("data", finalAudio);
      inputStdout.emit("end");
      inputStdout.emit("close");

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
    const inputStdout = new EventEmitter();
    const inputProcess = createProcess({ stdout: inputStdout, autoClose: false });
    const outputStdin = createStdin(false);
    const outputProcess = createProcess({ stdin: outputStdin });
    childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const bridgeId = started.bridgeId as string;
    const pushing = invokeHost(host, {
      action: "pushAudio",
      base64: Buffer.from([1, 2, 3]).toString("base64"),
      bridgeId,
      outputGeneration: 0,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    inputProcess.stderr.emit("error", new Error("capture failed"));

    await expect(pushing).resolves.toEqual({ bridgeId, ok: true, stale: true });
    await expect(
      invokeHost(host, {
        action: "pushAudio",
        base64: Buffer.from([4, 5, 6]).toString("base64"),
        bridgeId,
        outputGeneration: 0,
      }),
    ).rejects.toThrow(`bridge is not open: ${bridgeId}`);
    await expect(
      invokeHost(host, { action: "clearAudio", bridgeId, outputGeneration: 1 }),
    ).rejects.toThrow(`bridge is not open: ${bridgeId}`);
    await expect(invokeHost(host, { action: "status", bridgeId })).resolves.toMatchObject({
      bridge: { bridgeId, closed: true },
    });
    await expect(
      invokeHost(host, {
        action: "list",
        url: "https://meeting.test",
        mode: "bidi",
      }),
    ).resolves.toEqual({ bridges: [] });
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);

    inputStdout.emit("end");
    inputStdout.emit("close");
    await expect(invokeHost(host, { action: "stop", bridgeId })).resolves.toEqual({
      ok: true,
      stopped: false,
    });
  });

  it("drains final audio when input closes between sequential pulls", async () => {
    const inputStdout = new EventEmitter();
    const inputProcess = createProcess({ stdout: inputStdout });
    const outputProcess = createProcess({ stdin: createStdin(true) });
    childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const bridgeId = started.bridgeId as string;
    const firstAudio = Buffer.from([1, 2, 3]);
    const finalAudio = Buffer.from([4, 5, 6]);

    inputStdout.emit("data", firstAudio);
    inputStdout.emit("data", finalAudio);
    inputProcess.stderr.emit("error", new Error("capture failed"));
    await Promise.resolve();

    await expect(invokeHost(host, { action: "pullAudio", bridgeId })).resolves.toEqual({
      bridgeId,
      closed: false,
      base64: firstAudio.toString("base64"),
    });
    await expect(invokeHost(host, { action: "pullAudio", bridgeId })).resolves.toEqual({
      bridgeId,
      closed: true,
      base64: finalAudio.toString("base64"),
    });
    await vi.waitFor(async () => {
      await expect(invokeHost(host, { action: "pullAudio", bridgeId })).rejects.toThrow(
        `unknown bridgeId: ${bridgeId}`,
      );
    });
  });

  it("starts terminal eviction after capture drain becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const inputStdout = new EventEmitter();
      const inputProcess = createProcess({ stdout: inputStdout, autoClose: false });
      const outputProcess = createProcess({ stdin: createStdin(true) });
      childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
      const host = createHost();
      const started = await invokeHost(host, {
        action: "start",
        audioInputCommand: ["capture"],
        audioOutputCommand: ["play"],
        launch: false,
        mode: "bidi",
      });
      const bridgeId = started.bridgeId as string;

      const firstAudio = Buffer.from([1, 2, 3]);
      const finalAudio = Buffer.from([4, 5, 6]);
      inputStdout.emit("data", firstAudio);
      inputStdout.emit("data", finalAudio);
      inputProcess.stderr.emit("error", new Error("capture failed"));
      await expect(invokeHost(host, { action: "pullAudio", bridgeId })).resolves.toEqual({
        bridgeId,
        closed: false,
        base64: firstAudio.toString("base64"),
      });

      await vi.advanceTimersByTimeAsync(3_000);
      inputStdout.emit("end");
      inputStdout.emit("close");
      await vi.advanceTimersByTimeAsync(2_100);

      await expect(invokeHost(host, { action: "status", bridgeId })).resolves.toMatchObject({
        bridge: { bridgeId, closed: true, queuedInputChunks: 1 },
      });
      await vi.advanceTimersByTimeAsync(2_899);
      await expect(invokeHost(host, { action: "status", bridgeId })).resolves.toMatchObject({
        bridge: { bridgeId, closed: true, queuedInputChunks: 1 },
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(invokeHost(host, { action: "pullAudio", bridgeId })).rejects.toThrow(
        `unknown bridgeId: ${bridgeId}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps terminal audio while pull progress continues", async () => {
    vi.useFakeTimers();
    try {
      const inputStdout = new EventEmitter();
      const inputProcess = createProcess({ stdout: inputStdout });
      const outputProcess = createProcess({ stdin: createStdin(true) });
      childProcessMocks.spawn.mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
      const host = createHost();
      const started = await invokeHost(host, {
        action: "start",
        audioInputCommand: ["capture"],
        audioOutputCommand: ["play"],
        launch: false,
        mode: "bidi",
      });
      const bridgeId = started.bridgeId as string;
      const firstAudio = Buffer.from([1, 2, 3]);
      const finalAudio = Buffer.from([4, 5, 6]);

      inputStdout.emit("data", firstAudio);
      inputStdout.emit("data", finalAudio);
      inputProcess.stderr.emit("error", new Error("capture failed"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(invokeHost(host, { action: "pullAudio", bridgeId })).resolves.toEqual({
        bridgeId,
        closed: false,
        base64: firstAudio.toString("base64"),
      });
      await vi.advanceTimersByTimeAsync(4_999);
      await expect(invokeHost(host, { action: "status", bridgeId })).resolves.toMatchObject({
        bridge: { bridgeId, closed: true, queuedInputChunks: 1 },
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(invokeHost(host, { action: "pullAudio", bridgeId })).rejects.toThrow(
        `unknown bridgeId: ${bridgeId}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears and deletes input retention on explicit stop", async () => {
    const inputStdout = new EventEmitter();
    childProcessMocks.spawn
      .mockReturnValueOnce(createProcess({ stdin: createStdin(true) }))
      .mockReturnValueOnce(createProcess({ stdout: inputStdout }));
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const bridgeId = started.bridgeId as string;
    inputStdout.emit("data", Buffer.alloc(64 * 1024));

    await expect(invokeHost(host, { action: "stop", bridgeId })).resolves.toEqual({
      ok: true,
      stopped: true,
    });
    await expect(invokeHost(host, { action: "stop", bridgeId })).resolves.toEqual({
      ok: true,
      stopped: false,
    });
    await expect(invokeHost(host, { action: "pullAudio", bridgeId })).rejects.toThrow(
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

    await expect(
      invokeHost(host, {
        action: "start",
        audioInputCommand: ["capture"],
        audioOutputCommand: ["play"],
        launch: false,
        mode: "bidi",
      }),
    ).rejects.toBe(spawnError);
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

    await expect(
      invokeHost(host, {
        action: "start",
        audioInputCommand: ["capture"],
        audioOutputCommand: ["play"],
        mode: "bidi",
      }),
    ).rejects.toThrow("failed to launch Chrome for Test Browser: launch failed");
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

    await expect(
      invokeHost(host, {
        action: "start",
        audioInputCommand: ["capture"],
        audioOutputCommand: ["play"],
        mode: "bidi",
      }),
    ).rejects.toBe(launchError);
    await vi.waitFor(async () => {
      await expect(invokeHost(host, { action: "pullAudio", bridgeId })).rejects.toThrow(
        `unknown bridgeId: ${bridgeId}`,
      );
    });
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("waits for the output stream to accept a backpressured chunk", async () => {
    const outputStdin = createStdin(false);
    childProcessMocks.spawn
      .mockReturnValueOnce(createProcess({ stdin: outputStdin }))
      .mockReturnValueOnce(createProcess({ stdout: new EventEmitter() }));
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const bridgeId = started.bridgeId;

    let settled = false;
    const pushing = invokeHost(host, {
      action: "pushAudio",
      base64: Buffer.from([1, 2, 3]).toString("base64"),
      bridgeId,
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
    await invokeHost(host, { action: "stop", bridgeId });
  });

  it("rejects output generations outside the safe integer range", async () => {
    childProcessMocks.spawn
      .mockReturnValueOnce(createProcess({ stdin: createStdin(true) }))
      .mockReturnValueOnce(createProcess({ stdout: new EventEmitter() }));
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });

    await expect(
      invokeHost(host, {
        action: "clearAudio",
        bridgeId: started.bridgeId,
        outputGeneration: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("outputGeneration must be a non-negative integer");
    await invokeHost(host, { action: "stop", bridgeId: started.bridgeId });
  });

  it("waits for output acceptance and rejects stale generations after clear", async () => {
    const originalStdin = createStdin(false);
    const replacementStdin = createStdin(true);
    childProcessMocks.spawn
      .mockReturnValueOnce(createProcess({ stdin: originalStdin }))
      .mockReturnValueOnce(createProcess({ stdout: new EventEmitter() }))
      .mockReturnValueOnce(createProcess({ stdin: replacementStdin }));
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const bridgeId = started.bridgeId;
    expect(typeof bridgeId).toBe("string");

    let firstPushSettled = false;
    const firstPush = invokeHost(host, {
      action: "pushAudio",
      base64: Buffer.from([1, 2, 3]).toString("base64"),
      bridgeId,
      outputGeneration: 0,
    }).then((result) => {
      firstPushSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(firstPushSettled).toBe(false);

    const cleared = await invokeHost(host, {
      action: "clearAudio",
      bridgeId,
      outputGeneration: 1,
    });
    expect(cleared).toMatchObject({ ok: true });
    await expect(firstPush).resolves.toMatchObject({
      ok: true,
      stale: true,
    });

    const stalePush = await invokeHost(host, {
      action: "pushAudio",
      base64: Buffer.from([4, 5, 6]).toString("base64"),
      bridgeId,
      outputGeneration: 0,
    });
    expect(stalePush).toMatchObject({ ok: true, stale: true });
    expect(replacementStdin.write).not.toHaveBeenCalled();

    await invokeHost(host, { action: "stop", bridgeId });
  });

  it("accepts legacy output commands and preserves their response shapes", async () => {
    const originalStdin = createStdin(true);
    const replacementStdin = createStdin(true);
    childProcessMocks.spawn
      .mockReturnValueOnce(createProcess({ stdin: originalStdin }))
      .mockReturnValueOnce(createProcess({ stdout: new EventEmitter() }))
      .mockReturnValueOnce(createProcess({ stdin: replacementStdin }));
    const host = createHost();
    const started = await invokeHost(host, {
      action: "start",
      audioInputCommand: ["capture"],
      audioOutputCommand: ["play"],
      launch: false,
      mode: "bidi",
    });
    const bridgeId = started.bridgeId;

    await expect(
      invokeHost(host, {
        action: "pushAudio",
        base64: Buffer.from([1, 2, 3]).toString("base64"),
        bridgeId,
      }),
    ).resolves.toEqual({ bridgeId, ok: true });
    await expect(invokeHost(host, { action: "clearAudio", bridgeId })).resolves.toEqual({
      bridgeId,
      ok: true,
      clearCount: 1,
    });
    await expect(
      invokeHost(host, {
        action: "pushAudio",
        base64: Buffer.from([4, 5, 6]).toString("base64"),
        bridgeId,
      }),
    ).resolves.toEqual({ bridgeId, ok: true });
    expect(originalStdin.write).toHaveBeenCalledOnce();
    expect(replacementStdin.write).toHaveBeenCalledOnce();

    await invokeHost(host, { action: "stop", bridgeId });
  });
});

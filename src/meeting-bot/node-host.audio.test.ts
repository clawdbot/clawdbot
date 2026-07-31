import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcessMocks.spawn,
  spawnSync: childProcessMocks.spawnSync,
}));

import { createMeetingNodeHost } from "./node-host.js";

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

function createProcess(params: { stdin?: TestStdin | null; stdout?: EventEmitter | null }) {
  const events = new EventEmitter();
  const proc = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: params.stdin ?? null,
    stdout: params.stdout ?? null,
    stderr: new EventEmitter(),
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      proc.signalCode = signal;
      queueMicrotask(() => events.emit("exit", null, signal));
      return true;
    }),
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
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
  afterEach(() => {
    vi.resetAllMocks();
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

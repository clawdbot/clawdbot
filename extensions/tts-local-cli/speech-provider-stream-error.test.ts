import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SpeechProviderConfig, SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const runFfmpegMock = vi.hoisted(() => vi.fn<(args: string[]) => Promise<void>>());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  runFfmpeg: runFfmpegMock,
}));

import { buildCliSpeechProvider } from "./speech-provider.js";

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: () => void; write: (data: string) => void };
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { end: () => void; write: () => void };
  stdin.end = () => {};
  stdin.write = () => {};
  child.stdin = stdin;
  child.kill = vi.fn(() => true);
  return child;
}

const TEST_CFG = {} as OpenClawConfig;
const MIB = 1024 * 1024;

type SpeechTarget = SpeechSynthesisRequest["target"];

function providerConfig(params: { args?: string[]; timeoutMs?: number }): SpeechProviderConfig {
  return {
    command: "/fake/tts",
    args: params.args,
    outputFormat: "wav",
    timeoutMs: params.timeoutMs ?? 5000,
  };
}

async function waitForSpawn() {
  await vi.waitUntil(() => spawnMock.mock.calls.length > 0, { timeout: 2000 });
  const args = spawnMock.mock.lastCall?.[1];
  if (!Array.isArray(args)) {
    throw new Error("spawn args missing");
  }
  return args as string[];
}

async function startSpeech(params: {
  child: MockChild;
  args?: string[];
  timeoutMs?: number;
  target?: SpeechTarget;
}) {
  spawnMock.mockReturnValue(params.child);
  const promise = buildCliSpeechProvider().synthesize({
    text: "hello",
    cfg: TEST_CFG,
    providerConfig: providerConfig(params),
    providerOverrides: {},
    timeoutMs: params.timeoutMs ?? 5000,
    target: params.target ?? "audio-file",
  });
  const args = await waitForSpawn();
  return { args, promise };
}

async function startTelephony(params: { child: MockChild; args?: string[]; timeoutMs?: number }) {
  spawnMock.mockReturnValue(params.child);
  const promise = buildCliSpeechProvider().synthesizeTelephony?.({
    text: "hello",
    cfg: TEST_CFG,
    providerConfig: providerConfig(params),
    providerOverrides: {},
    timeoutMs: params.timeoutMs ?? 5000,
  });
  if (!promise) {
    throw new Error("telephony synthesis missing");
  }
  const args = await waitForSpawn();
  return { args, promise };
}

function requireOutputPath(args: string[]): string {
  const outputIndex = args.indexOf("--out");
  const outputPath = args[outputIndex + 1];
  if (outputIndex < 0 || typeof outputPath !== "string") {
    throw new Error("output path missing");
  }
  return outputPath;
}

async function expectStillPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe("CLI TTS provider stream error handling", () => {
  beforeEach(() => {
    runFfmpegMock.mockImplementation(async (args) => {
      const outputPath = args.at(-1);
      if (!outputPath) {
        throw new Error("ffmpeg output path missing");
      }
      writeFileSync(outputPath, Buffer.from("converted"));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("rejects partial stdout instead of returning truncated audio", async () => {
    const child = createMockChild();
    const { promise } = await startSpeech({ child });

    child.stdout.emit("data", Buffer.from("partial"));
    child.stdout.emit("error", new Error("EPIPE: audio stream broken"));
    child.emit("close", 0);

    await expect(promise).rejects.toThrow(
      "CLI TTS stdout stream error: EPIPE: audio stream broken",
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["speech", "telephony"] as const)(
    "keeps valid %s file output when incidental stdout errors",
    async (mode) => {
      const child = createMockChild();
      const started =
        mode === "speech"
          ? await startSpeech({ child, args: ["--out", "{{OutputPath}}"] })
          : await startTelephony({ child, args: ["--out", "{{OutputPath}}"] });
      writeFileSync(requireOutputPath(started.args), Buffer.from("file-audio"));

      child.stdout.emit("error", new Error("EPIPE: unused stdout broken"));
      child.emit("close", 0);

      await expect(started.promise).resolves.toMatchObject({
        audioBuffer: mode === "speech" ? Buffer.from("file-audio") : Buffer.from("converted"),
      });
      expect(child.kill).not.toHaveBeenCalled();
      expect(runFfmpegMock).toHaveBeenCalledTimes(mode === "telephony" ? 1 : 0);
    },
  );

  it("keeps synthesized audio when only the diagnostic stream errors", async () => {
    const child = createMockChild();
    const { promise } = await startSpeech({ child });

    child.stdout.emit("data", Buffer.from("audio"));
    child.stderr.emit("error", new Error("EPIPE: diagnostics stream broken"));
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ audioBuffer: Buffer.from("audio") });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("reports diagnostic stream loss when the child exits unsuccessfully", async () => {
    const child = createMockChild();
    const { promise } = await startSpeech({ child });

    child.stderr.emit("data", Buffer.from("partial diagnostic"));
    child.stderr.emit("error", new Error("EIO: diagnostics stream broken"));
    child.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "CLI TTS exit 1: partial diagnostic; CLI TTS stderr stream error: EIO: diagnostics stream broken",
    );
  });

  it.each([
    { stream: "stdout", chunkBytes: MIB, repeats: 51, limitBytes: 50 * MIB },
    { stream: "stderr", chunkBytes: MIB / 2, repeats: 3, limitBytes: MIB },
  ] as const)("terminates the child when $stream exceeds its byte cap", async (testCase) => {
    const child = createMockChild();
    const { promise } = await startSpeech({ child });
    const chunk = Buffer.alloc(testCase.chunkBytes);

    for (let index = 0; index < testCase.repeats; index += 1) {
      child[testCase.stream].emit("data", chunk);
    }
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("close", null);

    await expect(promise).rejects.toThrow(
      `CLI TTS ${testCase.stream} exceeded ${testCase.limitBytes} bytes`,
    );
  });

  it("waits for close before settling a process error", async () => {
    const child = createMockChild();
    const { promise } = await startSpeech({ child });

    child.emit("error", new Error("spawn failed"));
    await expectStillPending(promise);
    child.emit("close", null);

    await expect(promise).rejects.toThrow("CLI TTS failed: spawn failed");
  });

  it("keeps timeout kill escalation armed across process errors", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const child = createMockChild();
    const { promise } = await startSpeech({ child, timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill.mock.calls[0]).toEqual([]);
    child.emit("error", new Error("SIGTERM delivery failed"));
    await expectStillPending(promise);

    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.emit("close", null);

    await expect(promise).rejects.toThrow("CLI TTS timed out after 100ms");
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledTimes(2);
  });
});

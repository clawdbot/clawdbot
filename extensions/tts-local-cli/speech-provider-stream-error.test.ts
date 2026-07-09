import { EventEmitter } from "node:events";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  runFfmpeg: vi.fn(),
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

async function synthesize(child: MockChild) {
  spawnMock.mockReturnValue(child);
  const promise = buildCliSpeechProvider().synthesize({
    text: "hello",
    cfg: TEST_CFG,
    providerConfig: { command: "/fake/tts", outputFormat: "wav", timeoutMs: 5000 },
    providerOverrides: {},
    timeoutMs: 5000,
    target: "audio-file",
  });
  await vi.waitUntil(() => spawnMock.mock.calls.length > 0, { timeout: 2000 });
  return { promise };
}

describe("CLI TTS provider stream error handling", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects on stdout stream error instead of silently returning truncated audio", async () => {
    const child = createMockChild();
    const { promise } = await synthesize(child);

    child.stdout.emit("error", new Error("EPIPE: audio stream broken"));
    child.emit("close", null, "SIGTERM");

    await expect(promise).rejects.toThrow("CLI TTS stdout stream error");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("keeps synthesized audio when only the diagnostic stream errors", async () => {
    const child = createMockChild();
    const { promise } = await synthesize(child);

    child.stdout.emit("data", Buffer.from("audio"));
    child.stderr.emit("error", new Error("EPIPE: diagnostics stream broken"));
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ audioBuffer: Buffer.from("audio") });
    expect(child.kill).not.toHaveBeenCalled();
  });
});

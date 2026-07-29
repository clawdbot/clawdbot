// TTS local CLI tests cover the canonical process-wrapper contract.
import { writeFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCommandBufferedMock } = vi.hoisted(() => ({ runCommandBufferedMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandBuffered: runCommandBufferedMock,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  runFfmpeg: vi.fn(),
}));

import { buildCliSpeechProvider } from "./speech-provider.js";

const TEST_CFG = {} as OpenClawConfig;
const MIB = 1024 * 1024;

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    stdout: Buffer.from("audio"),
    stderr: Buffer.alloc(0),
    ...overrides,
  };
}

async function synthesize(args = ["--voice", "test"]) {
  return await buildCliSpeechProvider().synthesize({
    text: "hello",
    cfg: TEST_CFG,
    providerConfig: {
      command: "/fake/tts",
      args,
      outputFormat: "wav",
      timeoutMs: 2_500,
    },
    providerOverrides: {},
    timeoutMs: 2_500,
    target: "audio-file",
  });
}

describe("CLI TTS process wrapper", () => {
  beforeEach(() => {
    runCommandBufferedMock.mockReset();
    runCommandBufferedMock.mockResolvedValue(commandResult());
  });

  it("uses Execa input, timeout, escalation, and asymmetric byte caps", async () => {
    await expect(synthesize()).resolves.toMatchObject({ audioBuffer: Buffer.from("audio") });

    expect(runCommandBufferedMock).toHaveBeenCalledWith(
      ["/fake/tts", "--voice", "test"],
      expect.objectContaining({
        input: "hello",
        maxOutputBytes: { stdout: 50 * MIB, stderr: MIB },
        timeoutMs: 2_500,
      }),
    );
  });

  it("maps timeout and output-limit failures", async () => {
    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({ code: null, termination: "timeout" }),
    );
    await expect(synthesize()).rejects.toThrow("CLI TTS timed out after 2500ms");

    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({
        code: 0,
        termination: "output-limit",
        outputLimitStream: "stderr",
      }),
    );
    await expect(synthesize()).rejects.toThrow(`CLI TTS stderr exceeded ${MIB} bytes`);
  });

  it("keeps exit diagnostics", async () => {
    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({ code: 2, stderr: Buffer.from("bad voice") }),
    );

    await expect(synthesize()).rejects.toThrow("CLI TTS exit 2: bad voice");
  });

  it("rejects errored stdout but keeps a generated audio file authoritative", async () => {
    const streamError = new Error("stdout stream failed");
    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({
        code: null,
        error: streamError,
        errorStream: "stdout",
        stdout: Buffer.from("partial"),
        termination: "error",
      }),
    );
    await expect(synthesize()).rejects.toThrow("CLI TTS failed: stdout stream failed");

    runCommandBufferedMock.mockImplementationOnce(async (argv: string[]) => {
      writeFileSync(argv[1]!, Buffer.from("file-audio"));
      return commandResult({
        code: 0,
        error: streamError,
        stdout: Buffer.from("partial"),
        termination: "error",
      });
    });
    await expect(synthesize(["{{OutputPath}}"])).resolves.toMatchObject({
      audioBuffer: Buffer.from("file-audio"),
    });

    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({
        code: 0,
        error: new Error("stderr stream failed"),
        errorStream: "stderr",
        stdout: Buffer.from("stdout-audio"),
        termination: "error",
      }),
    );
    await expect(synthesize()).resolves.toMatchObject({
      audioBuffer: Buffer.from("stdout-audio"),
    });
  });
});

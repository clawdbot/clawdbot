// FFmpeg exec tests cover command execution wrappers and error mapping.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseFfprobeCodecAndSampleRate,
  parseFfprobeCsvFields,
  resolveFfmpegBin,
  runFfprobe,
} from "./ffmpeg-exec.js";

const { runExecMock, resolveSystemBinMock } = vi.hoisted(() => ({
  runExecMock: vi.fn(),
  resolveSystemBinMock: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec: runExecMock,
}));

vi.mock("../infra/resolve-system-bin.js", () => ({
  resolveSystemBin: resolveSystemBinMock,
}));

beforeEach(() => {
  runExecMock.mockReset();
  resolveSystemBinMock.mockReset();
  resolveSystemBinMock.mockReturnValue("/usr/bin/ffprobe");
});

describe("parseFfprobeCsvFields", () => {
  function expectParsedFfprobeCsvCase(input: string, fieldCount: number, expected: string[]) {
    expect(parseFfprobeCsvFields(input, fieldCount)).toEqual(expected);
  }

  it.each([
    { input: "opus,\n48000\n", fieldCount: 2, expected: ["opus", "48000"] },
    { input: "opus,48000,stereo\n", fieldCount: 3, expected: ["opus", "48000", "stereo"] },
  ] as const)("splits ffprobe csv output %#", ({ input, fieldCount, expected }) => {
    expectParsedFfprobeCsvCase(input, fieldCount, [...expected]);
  });
});

describe("parseFfprobeCodecAndSampleRate", () => {
  function expectParsedCodecAndSampleRateCase(
    input: string,
    expected: { codec: string | null; sampleRateHz: number | null },
  ) {
    expect(parseFfprobeCodecAndSampleRate(input)).toEqual(expected);
  }

  it.each([
    {
      name: "normalizes codec casing and parses numeric sample rates",
      input: "Opus,48000\n",
      expected: {
        codec: "opus",
        sampleRateHz: 48_000,
      },
    },
    {
      name: "keeps codec when the sample rate is not numeric",
      input: "opus,not-a-number",
      expected: {
        codec: "opus",
        sampleRateHz: null,
      },
    },
    {
      name: "rejects partially numeric sample rates",
      input: "opus,48000hz",
      expected: {
        codec: "opus",
        sampleRateHz: null,
      },
    },
    {
      name: "rejects missing sample rates",
      input: "opus,",
      expected: {
        codec: "opus",
        sampleRateHz: null,
      },
    },
    {
      name: "rejects zero sample rates",
      input: "opus,0",
      expected: {
        codec: "opus",
        sampleRateHz: null,
      },
    },
    {
      name: "rejects signed sample rates",
      input: "opus,-48000",
      expected: {
        codec: "opus",
        sampleRateHz: null,
      },
    },
  ] as const)("$name", ({ input, expected }) => {
    expectParsedCodecAndSampleRateCase(input, expected);
  });
});

describe("runFfprobe", () => {
  it("passes stdin and limits through the canonical exec wrapper", async () => {
    const input = Buffer.from("audio");
    runExecMock.mockResolvedValue({ stdout: "ok", stderr: "" });

    await expect(
      runFfprobe(["pipe:0"], { input, timeoutMs: 1234, maxBufferBytes: 5678 }),
    ).resolves.toBe("ok");

    expect(runExecMock).toHaveBeenCalledWith("/usr/bin/ffprobe", ["pipe:0"], {
      input,
      logOutput: false,
      maxBuffer: 5678,
      timeoutMs: 1234,
    });
  });

  it("preserves wrapper execution errors", async () => {
    const childError = new Error("ffprobe failed");
    runExecMock.mockRejectedValue(childError);

    await expect(runFfprobe(["pipe:0"], { input: Buffer.from("audio") })).rejects.toBe(childError);
  });
});

describe("resolveFfmpegBin", () => {
  it("resolves ffmpeg from trusted system paths", () => {
    resolveSystemBinMock.mockReturnValue("/usr/bin/ffmpeg");

    expect(resolveFfmpegBin()).toBe("/usr/bin/ffmpeg");
    expect(resolveSystemBinMock).toHaveBeenCalledWith("ffmpeg", { trust: "standard" });
  });
});

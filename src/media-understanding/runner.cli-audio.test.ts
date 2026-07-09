// CLI audio runner tests cover prompt/language templating and command execution
// options for local transcription binaries.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { CLI_OUTPUT_MAX_BUFFER } from "./defaults.constants.js";
import { withAudioFixture } from "./runner.test-utils.js";

const runExecMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

let runCliEntry: typeof import("./runner.entries.js").runCliEntry;

type TranscriptFileCase = {
  name: string;
  command: string;
  args: string[];
  resolvePath: (args: string[]) => string;
};

const transcriptFileCases: TranscriptFileCase[] = [
  {
    name: "whisper.cpp short flags",
    command: "whisper-cli",
    args: ["-otxt", "-of", "{{OutputBase}}", "{{MediaPath}}"],
    resolvePath: (args) => `${args[2]}.txt`,
  },
  {
    name: "whisper.cpp long flags",
    command: "whisper-cli",
    args: ["--output-txt", "--output-file={{OutputBase}}", "{{MediaPath}}"],
    resolvePath: (args) => `${args[1]?.slice("--output-file=".length)}.txt`,
  },
  {
    name: "OpenAI Whisper explicit txt",
    command: "whisper",
    args: ["{{MediaPath}}", "--output_format=txt", "--output_dir={{OutputDir}}"],
    resolvePath: (args) =>
      path.join(
        args[2]?.slice("--output_dir=".length) ?? "",
        `${path.parse(args[0] ?? "").name}.txt`,
      ),
  },
  {
    name: "OpenAI Whisper default all output",
    command: "whisper",
    args: ["-o", "{{OutputDir}}", "{{MediaPath}}"],
    resolvePath: (args) => path.join(args[1] ?? "", `${path.parse(args[2] ?? "").name}.txt`),
  },
  {
    name: "parakeet txt output",
    command: "parakeet-mlx",
    args: ["{{MediaPath}}", "--output-format", "txt", "--output-dir", "{{OutputDir}}"],
    resolvePath: (args) => path.join(args[4] ?? "", `${path.parse(args[0] ?? "").name}.txt`),
  },
  {
    name: "parakeet all output with default template",
    command: "parakeet-mlx",
    args: [
      "{{MediaPath}}",
      "--output-format=all",
      "--output-dir={{OutputDir}}",
      "--output-template={filename}",
    ],
    resolvePath: (args) =>
      path.join(
        args[2]?.slice("--output-dir=".length) ?? "",
        `${path.parse(args[0] ?? "").name}.txt`,
      ),
  },
];

function requireFirstRunExecCall(): unknown[] {
  const [call] = runExecMock.mock.calls;
  if (!call) {
    throw new Error("expected runExec call");
  }
  return call;
}

async function runAudioEntry(params: {
  command: string;
  args: string[];
}): Promise<Awaited<ReturnType<typeof runCliEntry>>> {
  let result: Awaited<ReturnType<typeof runCliEntry>> = null;
  await withAudioFixture(`openclaw-cli-${params.command}`, async ({ ctx, cache }) => {
    result = await runCliEntry({
      capability: "audio",
      entry: { type: "cli", command: params.command, args: params.args },
      cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
      ctx,
      attachmentIndex: 0,
      cache,
      config: {} as never,
    });
  });
  return result;
}

describe("media-understanding CLI audio entry", () => {
  beforeAll(async () => {
    ({ runCliEntry } = await import("./runner.entries.js"));
  });

  beforeEach(() => {
    runExecMock.mockReset().mockResolvedValue({ stdout: "cli transcript" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies per-request prompt and language overrides to CLI transcription templating", async () => {
    let mediaPath = "";

    await withAudioFixture("openclaw-cli-audio", async ({ ctx, cache }) => {
      mediaPath = await fs.realpath(ctx.MediaPath);

      await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "mock-transcriber",
          args: ["--prompt", "{{Prompt}}", "--language", "{{Language}}", "--file", "{{MediaPath}}"],
          prompt: "entry prompt",
          language: "de",
        },
        cfg: {
          tools: {
            media: {
              audio: {
                prompt: "configured prompt",
                language: "fr",
                _requestPromptOverride: "Focus on names",
                _requestLanguageOverride: "en",
              },
            },
          },
        } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {
          prompt: "configured prompt",
          language: "fr",
          _requestPromptOverride: "Focus on names",
          _requestLanguageOverride: "en",
        } as never,
      });
    });

    expect(runExecMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = requireFirstRunExecCall();
    expect(command).toBe("mock-transcriber");
    expect(args).toEqual(["--prompt", "Focus on names", "--language", "en", "--file", mediaPath]);
    expect(options).toEqual({
      timeoutMs: 60_000,
      maxBuffer: CLI_OUTPUT_MAX_BUFFER,
    });
  });

  it.each(transcriptFileCases)("reads $name transcript output", async (testCase) => {
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      await fs.writeFile(testCase.resolvePath(args), "file transcript\n");
      return { stdout: "Transcribing...\n", stderr: "" };
    });

    const result = await runAudioEntry(testCase);

    expect(result?.text).toBe("file transcript");
  });

  it("reads parakeet txt output selected through its upstream environment", async () => {
    const testCase: TranscriptFileCase = {
      name: "parakeet environment output",
      command: "parakeet-mlx",
      args: ["{{MediaPath}}", "--output-dir", "{{OutputDir}}"],
      resolvePath: (args) => path.join(args[2] ?? "", `${path.parse(args[0] ?? "").name}.txt`),
    };
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      await fs.writeFile(testCase.resolvePath(args), "environment transcript\n");
      return { stdout: "Transcribing...\n", stderr: "" };
    });

    const result = await withEnvAsync(
      { PARAKEET_OUTPUT_FORMAT: "txt", PARAKEET_OUTPUT_TEMPLATE: undefined },
      async () => await runAudioEntry(testCase),
    );

    expect(result?.text).toBe("environment transcript");
  });

  it.each(
    transcriptFileCases.flatMap((testCase) =>
      (["empty", "missing"] as const).map((fileState) => Object.assign({ fileState }, testCase)),
    ),
  )("treats $fileState $name transcript output as empty", async (testCase) => {
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      if (testCase.fileState === "empty") {
        await fs.writeFile(testCase.resolvePath(args), "  \n");
      }
      return { stdout: "Transcribing with Whisper...\n", stderr: "" };
    });

    await expect(runAudioEntry(testCase)).resolves.toBeNull();
  });

  it.each([
    {
      name: "generic Node wrapper",
      command: "node",
      args: [
        "./skills/local-whisper/transcribe.js",
        "{{MediaPath}}",
        "--output-dir",
        "{{OutputDir}}",
      ],
    },
    {
      name: "parakeet default srt output",
      command: "parakeet-mlx",
      args: ["{{MediaPath}}", "--output-dir", "{{OutputDir}}"],
    },
    {
      name: "parakeet custom output template",
      command: "parakeet-mlx",
      args: [
        "{{MediaPath}}",
        "--output-format",
        "txt",
        "--output-dir",
        "{{OutputDir}}",
        "--output-template",
        "custom-{filename}",
      ],
    },
  ])("preserves stdout for $name without an inferred file contract", async (testCase) => {
    const result = await runAudioEntry(testCase);

    expect(result?.text).toBe("cli transcript");
  });

  it("surfaces unexpected transcript file read errors", async () => {
    const testCase = transcriptFileCases[0];
    if (!testCase) {
      throw new Error("missing transcript file test case");
    }
    runExecMock.mockImplementationOnce(async (_command, args: string[]) => {
      await fs.mkdir(testCase.resolvePath(args));
      return { stdout: "Transcribing...\n", stderr: "" };
    });

    await expect(runAudioEntry(testCase)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("treats sherpa structured JSON with empty text as empty output", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout:
        '{"lang":"","emotion":"","event":"","text":"","timestamps":[],"durations":[],"tokens":[],"ys_log_probs":[],"words":[]}',
      stderr: "",
    });

    await withAudioFixture("openclaw-cli-audio-empty-sherpa", async ({ ctx, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "sherpa-onnx-offline",
          args: ["{{MediaPath}}"],
        },
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {} as never,
      });

      expect(result).toBeNull();
    });
  });

  it("extracts sherpa text from the final structured output line", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout: 'loading model\n{"text":"sherpa transcript","tokens":["sherpa","transcript"]}\n',
      stderr: "",
    });

    await withAudioFixture("openclaw-cli-audio-sherpa-json", async ({ ctx, cache }) => {
      const result = await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "sherpa-onnx-offline",
          args: ["{{MediaPath}}"],
        },
        cfg: { tools: { media: { audio: {} } } } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {} as never,
      });

      expect(result?.text).toBe("sherpa transcript");
    });
  });
});

// Tts Local Cli tests cover speech provider plugin behavior.
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SpeechProviderConfig, SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpeechSynthesisTarget = SpeechSynthesisRequest["target"];

const runFfmpegMock = vi.hoisted(() => vi.fn<(args: string[]) => Promise<string | void>>());
const debugLogMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  runFfmpeg: runFfmpegMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({ debug: debugLogMock }),
}));

import { buildCliSpeechProvider } from "./speech-provider.js";

const TEST_CFG = {} as OpenClawConfig;
const MAX_AUDIO_OUTPUT_BYTES = 50 * 1024 * 1024;
const VALID_MPEG_FRAME_HEADER = [0xff, 0xfb, 0x90, 0x64] as const;
const FREE_FORMAT_MPEG_FRAME_HEADER = [0xff, 0xfb, 0x00, 0x64] as const;
const EMPTY_ID3V2_HEADER = [...Buffer.from("ID3"), 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
const EMPTY_ID3V24_HEADER_WITH_FOOTER = [
  ...Buffer.from("ID3"),
  0x04,
  0x00,
  0x10,
  0x00,
  0x00,
  0x00,
  0x00,
];
const EMPTY_ID3V24_FOOTER = [...Buffer.from("3DI"), ...EMPTY_ID3V24_HEADER_WITH_FOOTER.slice(3)];

function createCliFixture(): { dir: string; script: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-tts-test-"));
  const script = path.join(dir, "write-audio.mjs");
  writeFileSync(
    script,
    `
import { writeFileSync } from "node:fs";

const outIndex = process.argv.indexOf("--out");
const outputPath = outIndex >= 0 ? process.argv[outIndex + 1] : "";
const textIndex = process.argv.indexOf("--text");
const textArg = textIndex >= 0 ? process.argv[textIndex + 1] : "";
const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
});
const payload = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.from(JSON.stringify({ args: process.argv.slice(2), stdin, textArg })),
]);
if (outputPath) {
  writeFileSync(outputPath, payload);
} else {
  process.stdout.write(payload);
}
`,
  );
  return { dir, script };
}

function createRawAudioFixture(audio: readonly number[]): { dir: string; script: string } {
  const fixture = createCliFixture();
  writeFileSync(
    fixture.script,
    `
import { writeFileSync } from "node:fs";
const outIndex = process.argv.indexOf("--out");
const outputPath = outIndex >= 0 ? process.argv[outIndex + 1] : "";
const audio = Buffer.from(${JSON.stringify(audio)});
if (outputPath) {
  writeFileSync(outputPath, audio);
} else {
  process.stdout.write(audio);
}
`,
  );
  return fixture;
}

function createOggFirstPage(firstPacket: Buffer): Buffer {
  const header = Buffer.alloc(27);
  header.write("OggS");
  header[26] = 1;
  return Buffer.concat([header, Buffer.from([firstPacket.length]), firstPacket]);
}

function baseProviderConfig(
  script: string,
  overrides: SpeechProviderConfig = {},
): SpeechProviderConfig {
  return {
    command: process.execPath,
    args: [script],
    timeoutMs: 1000,
    ...overrides,
  };
}

async function synthesize(params: {
  providerConfig: SpeechProviderConfig;
  text?: string;
  target?: SpeechSynthesisTarget;
}) {
  return await buildCliSpeechProvider().synthesize({
    text: params.text ?? "hello world",
    cfg: TEST_CFG,
    providerConfig: params.providerConfig,
    providerOverrides: {},
    timeoutMs: 1000,
    target: params.target ?? "audio-file",
  });
}

function parseAudioPayload(result: { audioBuffer: Buffer }) {
  const jsonStart = result.audioBuffer.indexOf("{");
  return JSON.parse(result.audioBuffer.subarray(jsonStart).toString("utf8")) as {
    stdin?: string;
    textArg?: string;
  };
}

function requireFfmpegArgs(index = 0) {
  const args = runFfmpegMock.mock.calls[index]?.[0];
  if (!args) {
    throw new Error(`runFfmpeg call ${index} missing`);
  }
  return args;
}

function expectArgsContainSequence(args: string[], sequence: string[]) {
  const startIndex = args.findIndex((arg, index) =>
    sequence.every((expected, offset) => args[index + offset] === expected),
  );
  expect(startIndex).toBeGreaterThanOrEqual(0);
}

describe("buildCliSpeechProvider", () => {
  beforeEach(() => {
    runFfmpegMock.mockImplementation(async (args) => {
      const outputPath = args.at(-1);
      if (typeof outputPath !== "string") {
        throw new Error("missing ffmpeg output path");
      }
      const stagedTarget = outputPath.endsWith(".part")
        ? outputPath.slice(0, -".part".length)
        : outputPath;
      const forcedFormatIndex = args.lastIndexOf("-f");
      const forcedFormat =
        forcedFormatIndex >= 0 && typeof args[forcedFormatIndex + 1] === "string"
          ? args[forcedFormatIndex + 1]
          : undefined;
      const extension =
        forcedFormat === "s16le"
          ? ".pcm"
          : forcedFormat
            ? `.${forcedFormat}`
            : path.extname(stagedTarget);
      writeFileSync(outputPath, Buffer.from(`converted:${extension}`));
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prefers canonical provider config over the cli alias", () => {
    const provider = buildCliSpeechProvider();

    expect(
      provider.resolveConfig?.({
        cfg: TEST_CFG,
        rawConfig: {
          providers: {
            cli: { command: "alias-command" },
            "tts-local-cli": { command: "canonical-command" },
          },
        },
        timeoutMs: 1000,
      }),
    ).toEqual({ command: "canonical-command" });
  });

  it("passes text through stdin when args omit the text template", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--out", "{{OutputPath}}"],
          outputFormat: "wav",
        }),
        text: "hello 😀 world",
      });

      expect(result.outputFormat).toBe("wav");
      expect(result.fileExtension).toBe(".wav");
      expect(result.voiceCompatible).toBe(false);
      const audioPayload = parseAudioPayload(result);
      expect(audioPayload.stdin).toBe("hello world");
      expect(audioPayload.textArg).toBe("");
      expect(runFfmpegMock).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("uses template args and stdout output when no output file is produced", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--text", "{{Text}}"],
          outputFormat: "wav",
        }),
        text: "spoken words",
      });

      expect(result.outputFormat).toBe("wav");
      expect(result.fileExtension).toBe(".wav");
      expect(result.voiceCompatible).toBe(false);
      const audioPayload = parseAudioPayload(result);
      expect(audioPayload.stdin).toBe("");
      expect(audioPayload.textArg).toBe("spoken words");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("converts non-opus output for voice-note targets", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--out", "{{OutputPath}}"],
          outputFormat: "mp3",
        }),
        target: "voice-note",
      });

      expect(result).toEqual({
        audioBuffer: Buffer.from("converted:.opus"),
        outputFormat: "opus",
        fileExtension: ".ogg",
        voiceCompatible: true,
      });
      expectArgsContainSequence(requireFfmpegArgs(), ["-c:a", "libopus", "-b:a", "64k"]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("converts stdout WAV to the requested audio-file format", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--text", "{{Text}}"],
          outputFormat: "mp3",
        }),
      });

      expect(result).toEqual({
        audioBuffer: Buffer.from("converted:.mp3"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      });
      expectArgsContainSequence(requireFfmpegArgs(), ["-c:a", "libmp3lame", "-b:a", "128k"]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      source: "ID3-tagged stdout",
      audio: [...EMPTY_ID3V2_HEADER, ...VALID_MPEG_FRAME_HEADER],
      writeFile: false,
    },
    {
      source: "ID3v2.4 footer stdout",
      audio: [
        ...EMPTY_ID3V24_HEADER_WITH_FOOTER,
        ...EMPTY_ID3V24_FOOTER,
        ...VALID_MPEG_FRAME_HEADER,
      ],
      writeFile: false,
    },
    { source: "free-format stdout", audio: FREE_FORMAT_MPEG_FRAME_HEADER, writeFile: false },
    { source: "untagged frame file", audio: VALID_MPEG_FRAME_HEADER, writeFile: true },
  ])("converts detected MP3 bytes from $source to configured WAV", async (testCase) => {
    const fixture = createRawAudioFixture(testCase.audio);
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [
            fixture.script,
            "--text",
            "{{Text}}",
            ...(testCase.writeFile ? ["--out", "{{OutputPath}}"] : []),
          ],
          outputFormat: "wav",
        }),
      });

      expect(result).toEqual({
        audioBuffer: Buffer.from("converted:.wav"),
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: false,
      });
      expectArgsContainSequence(requireFfmpegArgs(), ["-f", "wav"]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      codec: "OpusHead",
      packet: Buffer.from("OpusHeadnative-audio"),
      transport: "stdout",
      outputArgs: [],
    },
    {
      codec: "Vorbis",
      packet: Buffer.from("\x01vorbis-not-OpusHead"),
      transport: "templated file",
      outputArgs: ["--out", "{{OutputDir}}/{{OutputBase}}.ogg"],
    },
  ])("converts Ogg $codec from $transport to Opus for voice notes", async (testCase) => {
    const audio = createOggFirstPage(testCase.packet);
    const fixture = createRawAudioFixture([...audio]);
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--text", "{{Text}}", ...testCase.outputArgs],
          outputFormat: "opus",
        }),
        target: "voice-note",
      });

      expect(result).toEqual({
        audioBuffer: Buffer.from("converted:.opus"),
        outputFormat: "opus",
        fileExtension: ".ogg",
        voiceCompatible: true,
      });
      const ffmpegArgs = requireFfmpegArgs();
      expectArgsContainSequence(ffmpegArgs, ["-c:a", "libopus", "-b:a", "64k"]);
      expect(ffmpegArgs[ffmpegArgs.indexOf("-i") + 1]).toMatch(/\.ogg$/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("converts an M4A file to the configured MP3 target", async () => {
    const fixture = createRawAudioFixture([...Buffer.from("m4a fixture")]);
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--out", "{{OutputDir}}/{{OutputBase}}.m4a"],
          outputFormat: "mp3",
        }),
      });

      expect(result).toEqual({
        audioBuffer: Buffer.from("converted:.mp3"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      });
      const ffmpegArgs = requireFfmpegArgs();
      expectArgsContainSequence(ffmpegArgs, ["-c:a", "libmp3lame", "-b:a", "128k"]);
      expect(ffmpegArgs[ffmpegArgs.indexOf("-i") + 1]).toMatch(/\.m4a$/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "plain bytes", audio: [...Buffer.from("not audio")] },
    { label: "reserved MP3 layer", audio: [0xff, 0xf1, 0x90, 0x64] },
    { label: "bare ID3 prefix", audio: [...Buffer.from("ID3audio")] },
    {
      label: "ID3 tag with a non-sync-safe size",
      audio: [
        ...Buffer.from("ID3"),
        0x04,
        0x00,
        0x00,
        0x80,
        0x00,
        0x00,
        0x00,
        ...VALID_MPEG_FRAME_HEADER,
      ],
    },
    {
      label: "ID3 tag followed by a reserved MP3 layer",
      audio: [...EMPTY_ID3V2_HEADER, 0xff, 0xf1, 0x90, 0x64],
    },
  ])("rejects $label on stdout with supported-format guidance", async ({ audio }) => {
    const fixture = createRawAudioFixture(audio);
    try {
      await expect(
        synthesize({
          providerConfig: baseProviderConfig(fixture.script, {
            args: [fixture.script, "--text", "{{Text}}"],
            outputFormat: "wav",
          }),
        }),
      ).rejects.toThrow("stdout audio format is not recognized");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects unrecognized bytes written to a recognized audio extension", async () => {
    const fixture = createRawAudioFixture([...Buffer.from("not audio")]);
    try {
      await expect(
        synthesize({
          providerConfig: baseProviderConfig(fixture.script, {
            args: [fixture.script, "--out", "{{OutputPath}}"],
            outputFormat: "mp3",
          }),
        }),
      ).rejects.toThrow("unknown format");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("converts CLI output to raw telephony PCM", async () => {
    const fixture = createCliFixture();
    try {
      const result = await buildCliSpeechProvider().synthesizeTelephony?.({
        text: "phone reply",
        cfg: TEST_CFG,
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--out", "{{OutputPath}}"],
          outputFormat: "wav",
        }),
        timeoutMs: 1000,
      });

      expect(result).toEqual({
        audioBuffer: Buffer.from("converted:.pcm"),
        outputFormat: "pcm",
        sampleRate: 16000,
      });
      expectArgsContainSequence(requireFfmpegArgs(), ["-ar", "16000", "-ac", "1", "-f", "s16le"]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects oversized CLI output files before reading them", async () => {
    const fixture = createCliFixture();
    try {
      writeFileSync(
        fixture.script,
        `
import { truncateSync, writeFileSync } from "node:fs";
const outIndex = process.argv.indexOf("--out");
const outputPath = process.argv[outIndex + 1];
writeFileSync(outputPath, "");
truncateSync(outputPath, ${MAX_AUDIO_OUTPUT_BYTES + 1});
`,
      );

      await expect(
        synthesize({
          providerConfig: baseProviderConfig(fixture.script, {
            args: [fixture.script, "--out", "{{OutputPath}}"],
            outputFormat: "wav",
          }),
        }),
      ).rejects.toThrow(`File exceeds ${MAX_AUDIO_OUTPUT_BYTES} bytes`);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects non-file CLI output artifacts", async () => {
    const fixture = createCliFixture();
    try {
      writeFileSync(
        fixture.script,
        `
import { mkdirSync } from "node:fs";
const outIndex = process.argv.indexOf("--out");
mkdirSync(process.argv[outIndex + 1]);
`,
      );

      await expect(
        synthesize({
          providerConfig: baseProviderConfig(fixture.script, {
            args: [fixture.script, "--out", "{{OutputPath}}"],
            outputFormat: "wav",
          }),
        }),
      ).rejects.toThrow("path must be a regular file");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each(["voice-note", "telephony"] as const)(
    "rejects oversized ffmpeg output for %s synthesis",
    async (mode) => {
      const fixture = createCliFixture();
      runFfmpegMock.mockImplementation(async (args) => {
        const outputPath = args.at(-1);
        if (typeof outputPath !== "string") {
          throw new Error("missing ffmpeg output path");
        }
        writeFileSync(outputPath, "");
        truncateSync(outputPath, MAX_AUDIO_OUTPUT_BYTES + 1);
      });
      try {
        const providerConfig = baseProviderConfig(fixture.script, {
          args: [fixture.script, "--out", "{{OutputPath}}"],
          outputFormat: "wav",
        });
        const run =
          mode === "voice-note"
            ? synthesize({ providerConfig, target: "voice-note" })
            : buildCliSpeechProvider().synthesizeTelephony?.({
                text: "phone reply",
                cfg: TEST_CFG,
                providerConfig,
                providerOverrides: {},
                timeoutMs: 1000,
              });

        await expect(run).rejects.toThrow(`File exceeds ${MAX_AUDIO_OUTPUT_BYTES} bytes`);
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["synthesize", "synthesizeTelephony"] as const)(
    "keeps %s debug previews free of lone surrogates",
    async (method) => {
      const text = `${"a".repeat(49)}😀tail`;
      const providerConfig = { command: "missing-openclaw-tts-test-command" };
      const run =
        method === "synthesize"
          ? synthesize({ providerConfig, text })
          : buildCliSpeechProvider().synthesizeTelephony?.({
              text,
              cfg: TEST_CFG,
              providerConfig,
              timeoutMs: 1000,
            });
      await expect(run).rejects.toThrow();

      const preview = String(debugLogMock.mock.calls[0]?.[0]);
      expect(Buffer.from(preview).toString()).toBe(preview);
    },
  );
});

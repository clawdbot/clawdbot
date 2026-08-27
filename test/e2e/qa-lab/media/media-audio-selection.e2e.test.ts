import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../../../src/auto-reply/templating.js";
import type { OpenClawConfig } from "../../../../src/config/types.js";
import { applyMediaUnderstanding } from "../../../../src/media-understanding/apply.js";
import { MIN_AUDIO_FILE_BYTES } from "../../../../src/media-understanding/defaults.constants.js";
import type { MediaUnderstandingProvider } from "../../../../src/media-understanding/types.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

vi.mock("../../../../src/plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeAudioFixture(dir: string, name: string, fill: number): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, Buffer.alloc(MIN_AUDIO_FILE_BYTES + 1, fill));
  return filePath;
}

function createSelectionConfig(
  attachments: NonNullable<
    NonNullable<NonNullable<OpenClawConfig["tools"]>["media"]>["audio"]
  >["attachments"],
): OpenClawConfig {
  return {
    models: {
      providers: {
        "qa-stt": {
          apiKey: "qa-test-key", // pragma: allowlist secret
          baseUrl: "https://qa.invalid",
          models: [],
        },
      },
    },
    tools: {
      media: {
        models: [{ provider: "qa-stt", model: "fixture-stt", capabilities: ["audio"] }],
        audio: {
          enabled: true,
          attachments,
        },
      },
    },
  };
}

function createAudioProvider(seenFileNames: string[]): MediaUnderstandingProvider {
  return {
    id: "qa-stt",
    capabilities: ["audio"],
    resolveAuth: () => ({ kind: "none" as const, source: "qa-product-fixture" }),
    transcribeAudio: async (request: { fileName: string }) => {
      seenFileNames.push(request.fileName);
      return { text: `transcript:${request.fileName}`, model: "fixture-stt" };
    },
  };
}

async function writePortableTranscriber(dir: string): Promise<{
  command: string;
  markerPath: string;
}> {
  const markerPath = path.join(dir, "cli-ran.txt");
  const scriptPath = path.join(dir, "qa-transcriber.cjs");
  await fs.writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const [markerPath, mediaPath] = process.argv.slice(2);",
      "if (!markerPath || !mediaPath) process.exit(2);",
      "fs.writeFileSync(markerPath, mediaPath);",
      "process.stdout.write(`cli transcript:${path.basename(mediaPath)}\\n`);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  if (process.platform !== "win32") {
    return { command: scriptPath, markerPath };
  }

  const command = path.join(dir, "qa-transcriber.cmd");
  await fs.writeFile(command, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
  return { command, markerPath };
}

describe("QA media audio selection product proof", () => {
  it("applies mixed-attachment preference, mode, caps, and transcript ordering", async () => {
    const dir = tempDirs.make("openclaw-qa-media-audio-selection-");
    const firstAudio = await writeAudioFixture(dir, "first.ogg", 0x11);
    const secondAudio = await writeAudioFixture(dir, "second.ogg", 0x22);
    const thirdAudio = await writeAudioFixture(dir, "third.ogg", 0x33);
    const preflightAudio = await writeAudioFixture(dir, "preflight.ogg", 0x44);
    const imagePath = path.join(dir, "ignored.png");
    await fs.writeFile(imagePath, Buffer.from("not-an-audio-attachment"));
    const media = [
      { path: firstAudio, contentType: "audio/ogg" },
      { path: imagePath, contentType: "image/png" },
      { path: secondAudio, contentType: "audio/ogg" },
      { path: thirdAudio, contentType: "audio/ogg" },
      { path: preflightAudio, contentType: "audio/ogg", transcribed: true },
    ];

    const firstModeCalls: string[] = [];
    const firstModeCtx: MsgContext = { Body: "", media };
    const firstModeResult = await applyMediaUnderstanding({
      ctx: firstModeCtx,
      cfg: createSelectionConfig({ mode: "first", prefer: "last", maxAttachments: 3 }),
      providers: { "qa-stt": createAudioProvider(firstModeCalls) },
      processingMode: "audio-only",
      workspaceDir: dir,
    });

    expect(firstModeCalls).toEqual(["third.ogg"]);
    expect(firstModeResult.outputs.map((output) => output.attachmentIndex)).toEqual([3]);
    expect(firstModeCtx.Transcript).toBe("transcript:third.ogg");

    const allModeCalls: string[] = [];
    const allModeCtx: MsgContext = { Body: "", media };
    const allModeResult = await applyMediaUnderstanding({
      ctx: allModeCtx,
      cfg: createSelectionConfig({ mode: "all", prefer: "last", maxAttachments: 2 }),
      providers: { "qa-stt": createAudioProvider(allModeCalls) },
      processingMode: "audio-only",
      workspaceDir: dir,
    });

    expect(allModeCalls).toEqual(["third.ogg", "second.ogg"]);
    expect(allModeResult.outputs.map((output) => output.attachmentIndex)).toEqual([3, 2]);
    expect(
      allModeResult.decisions.find((decision) => decision.capability === "audio"),
    ).toMatchObject({
      outcome: "success",
      attachments: [{ attachmentIndex: 3 }, { attachmentIndex: 2 }],
    });
    expect(allModeCtx.Transcript).toBe(
      "Audio 1:\ntranscript:third.ogg\n\nAudio 2:\ntranscript:second.ogg",
    );
    expect(allModeCtx.Body).toBe(
      [
        "[Audio 1/2]\nTranscript:\ntranscript:third.ogg",
        "[Audio 2/2]\nTranscript:\ntranscript:second.ogg",
      ].join("\n\n"),
    );
  });

  it("falls through from a failed provider to an actual temporary CLI executable", async () => {
    const dir = tempDirs.make("openclaw-qa-media-audio-fallback-");
    const audioPath = await writeAudioFixture(dir, "fallback.wav", 0x55);
    const executable = await writePortableTranscriber(dir);
    let providerAttempts = 0;
    const ctx: MsgContext = {
      Body: "",
      media: [{ path: audioPath, contentType: "audio/wav" }],
    };
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "qa-stt": {
            apiKey: "qa-test-key", // pragma: allowlist secret
            baseUrl: "https://qa.invalid",
            models: [],
          },
        },
      },
      tools: {
        media: {
          models: [
            { provider: "qa-stt", model: "fixture-stt", capabilities: ["audio"] },
            {
              type: "cli",
              command: executable.command,
              args: [executable.markerPath, "{{MediaPath}}"],
              capabilities: ["audio"],
            },
          ],
          audio: { enabled: true },
        },
      },
    };

    const result = await applyMediaUnderstanding({
      ctx,
      cfg,
      providers: {
        "qa-stt": {
          id: "qa-stt",
          capabilities: ["audio"],
          resolveAuth: () => ({ kind: "none", source: "qa-product-fixture" }),
          transcribeAudio: async () => {
            providerAttempts += 1;
            throw new Error("intentional provider failure");
          },
        },
      },
      processingMode: "audio-only",
      workspaceDir: dir,
    });

    expect(providerAttempts).toBe(1);
    expect(await fs.readFile(executable.markerPath, "utf8")).toBe(await fs.realpath(audioPath));
    expect(ctx.Transcript).toBe("cli transcript:fallback.wav");
    const cliProvider = path.parse(executable.command).name;
    expect(result.outputs).toEqual([
      expect.objectContaining({
        attachmentIndex: 0,
        kind: "audio.transcription",
        provider: cliProvider,
        model: executable.command,
        text: "cli transcript:fallback.wav",
      }),
    ]);
    expect(result.decisions.find((decision) => decision.capability === "audio")).toMatchObject({
      outcome: "success",
      attachments: [
        {
          attachmentIndex: 0,
          attempts: [
            {
              type: "provider",
              provider: "qa-stt",
              model: "fixture-stt",
              outcome: "failed",
              reason: expect.stringContaining("intentional provider failure"),
            },
            {
              type: "cli",
              provider: cliProvider,
              model: executable.command,
              outcome: "success",
            },
          ],
          chosen: {
            type: "cli",
            provider: cliProvider,
            model: executable.command,
            outcome: "success",
          },
        },
      ],
    });
  });
});

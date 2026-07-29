// Microsoft plugin module implements tts behavior.
import { statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type EdgeTTSClient = Pick<import("node-edge-tts").EdgeTTS, "ttsPromise">;

export function inferEdgeExtension(outputFormat: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(outputFormat);
  if (normalized.includes("webm")) {
    return ".webm";
  }
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("opus")) {
    return ".opus";
  }
  if (normalized.includes("wav") || normalized.includes("riff") || normalized.includes("pcm")) {
    return ".wav";
  }
  return ".mp3";
}

export async function edgeTTS(
  params: {
    text: string;
    outputPath: string;
    config: {
      voice: string;
      lang: string;
      outputFormat: string;
      saveSubtitles: boolean;
      proxy?: string;
      rate?: string;
      pitch?: string;
      volume?: string;
      timeoutMs?: number;
    };
    timeoutMs: number;
  },
  ttsOverride?: EdgeTTSClient,
): Promise<void> {
  const { text, outputPath, config, timeoutMs } = params;
  if (text.trim().length === 0) {
    throw new Error("Microsoft TTS text cannot be empty");
  }

  const tts =
    ttsOverride ??
    new (await import("node-edge-tts")).EdgeTTS({
      voice: config.voice,
      lang: config.lang,
      outputFormat: config.outputFormat,
      saveSubtitles: config.saveSubtitles,
      proxy: config.proxy,
      rate: config.rate,
      pitch: config.pitch,
      volume: config.volume,
      timeout: config.timeoutMs ?? timeoutMs,
    });

  await mkdir(path.dirname(outputPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let outputSize = 0;
    await writeExternalFileWithinRoot({
      rootDir: path.dirname(outputPath),
      path: path.basename(outputPath),
      write: async (tempPath) => {
        writeFileSync(tempPath, "");
        await tts.ttsPromise(text, tempPath);
        outputSize = statSync(tempPath).size;
      },
    });
    if (outputSize > 0) {
      return;
    }
  }
  throw new Error("Edge TTS produced empty audio file after retry");
}

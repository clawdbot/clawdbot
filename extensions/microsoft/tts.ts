import { statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type EdgeTTSRuntimeConfig = {
  voice?: string;
  lang?: string;
  outputFormat?: string;
  saveSubtitles?: boolean;
  proxy?: string;
  rate?: string;
  pitch?: string;
  volume?: string;
  timeout?: number;
};

type EdgeTTSDeps = {
  EdgeTTS: new (config: EdgeTTSRuntimeConfig) => {
    ttsPromise: (text: string, outputPath: string) => Promise<unknown>;
  };
};

async function loadDefaultEdgeTTSDeps(): Promise<EdgeTTSDeps> {
  const { EdgeTTS } = await import("node-edge-tts");
  return { EdgeTTS };
}

function isMissingOutputFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function readOutputSize(outputPath: string): number {
  try {
    return statSync(outputPath).size;
  } catch (error) {
    if (isMissingOutputFileError(error)) {
      return 0;
    }
    throw error;
  }
}

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
  deps?: EdgeTTSDeps,
): Promise<void> {
  const { text, outputPath, config, timeoutMs } = params;
  if (text.trim().length === 0) {
    throw new Error("Microsoft TTS text cannot be empty");
  }

  const resolvedDeps = deps ?? (await loadDefaultEdgeTTSDeps());
  const tts = new resolvedDeps.EdgeTTS({
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outputSize = await writeEdgeTtsOutput({
      outputPath,
      ttsPromise: async (tempPath) => {
        await tts.ttsPromise(text, tempPath);
      },
    });
    if (outputSize > 0) {
      return;
    }
  }
  throw new Error("Edge TTS produced empty audio file after retry");
}

async function writeEdgeTtsOutput(params: {
  outputPath: string;
  ttsPromise: (tempPath: string) => Promise<void>;
}): Promise<number> {
  const rootDir = path.dirname(params.outputPath);
  await mkdir(rootDir, { recursive: true });
  let outputSize = 0;
  await writeExternalFileWithinRoot({
    rootDir,
    path: path.basename(params.outputPath),
    write: async (tempPath) => {
      await params.ttsPromise(tempPath);
      outputSize = readOutputSize(tempPath);
      if (outputSize === 0) {
        writeFileSync(tempPath, "");
      }
    },
  });
  return outputSize;
}

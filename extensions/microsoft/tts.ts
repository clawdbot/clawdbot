import { statSync } from "node:fs";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

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
    await tts.ttsPromise(text, outputPath);
    if (readOutputSize(outputPath) > 0) {
      return;
    }
  }
  throw new Error("Edge TTS produced empty audio file after retry");
}

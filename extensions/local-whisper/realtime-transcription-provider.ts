import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/realtime-transcription";
import { createLocalWhisperRealtimeTranscriptionSession } from "./session.js";

export const DEFAULT_LOCAL_WHISPER_MODEL = "small";

export type LocalWhisperConfig = {
  model: string;
  language: string;
  device: string;
  computeType: string;
  silenceMs: number;
  vadAggressiveness: number;
  maxUtteranceMs: number;
  pythonPath: string | undefined;
  workerScript: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

function nestedConfig(rawConfig: RealtimeTranscriptionProviderConfig): Record<string, unknown> {
  const raw = record(rawConfig) ?? {};
  const providers = record(raw.providers);
  return record(providers?.["local-whisper"]) ?? record(raw["local-whisper"]) ?? raw;
}

function defaultWorkerScript(): string {
  return fileURLToPath(new URL("./worker.py", import.meta.url));
}

export function resolveLocalWhisperConfig(
  rawConfig: RealtimeTranscriptionProviderConfig,
): LocalWhisperConfig {
  const raw = nestedConfig(rawConfig);
  const silenceMs = finiteInteger(raw.silenceMs) ?? 700;
  const vadAggressiveness = finiteInteger(raw.vadAggressiveness) ?? 2;
  const maxUtteranceMs = finiteInteger(raw.maxUtteranceMs) ?? 30_000;
  if (silenceMs <= 0) {
    throw new Error("Local Whisper silenceMs must be a positive integer");
  }
  if (vadAggressiveness < 0 || vadAggressiveness > 3) {
    throw new Error("Local Whisper vadAggressiveness must be between 0 and 3");
  }
  if (maxUtteranceMs <= 0) {
    throw new Error("Local Whisper maxUtteranceMs must be a positive integer");
  }
  return {
    model: optionalString(raw.model) ?? DEFAULT_LOCAL_WHISPER_MODEL,
    language: optionalString(raw.language) ?? "no",
    device: optionalString(raw.device) ?? "cpu",
    computeType: optionalString(raw.computeType) ?? "int8",
    silenceMs,
    vadAggressiveness,
    maxUtteranceMs,
    pythonPath: optionalString(raw.pythonPath) ?? optionalString(process.env.LOCAL_WHISPER_PYTHON),
    workerScript: optionalString(raw.workerScript) ?? defaultWorkerScript(),
  };
}

function isExistingAbsolutePath(command: string | undefined): command is string {
  if (!command || !isAbsolute(command) || !existsSync(command)) {
    return false;
  }
  try {
    accessSync(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function buildLocalWhisperRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "local-whisper",
    label: "Local Whisper (faster-whisper)",
    aliases: ["faster-whisper", "whisper-local"],
    defaultModel: DEFAULT_LOCAL_WHISPER_MODEL,
    autoSelectOrder: 20,
    resolveConfig: ({ rawConfig }) => resolveLocalWhisperConfig(rawConfig),
    isConfigured: ({ providerConfig }) => {
      try {
        const config = resolveLocalWhisperConfig(providerConfig);
        accessSync(config.workerScript, constants.R_OK);
        return isExistingAbsolutePath(config.pythonPath);
      } catch {
        return false;
      }
    },
    createSession: (request) => {
      const config = resolveLocalWhisperConfig(request.providerConfig);
      if (!isExistingAbsolutePath(config.pythonPath)) {
        throw new Error(
          "Local Whisper requires an existing absolute pythonPath or LOCAL_WHISPER_PYTHON",
        );
      }
      return createLocalWhisperRealtimeTranscriptionSession({ ...request, ...config });
    },
  };
}

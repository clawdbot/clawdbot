import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import type { TtsAutoMode, TtsMode } from "../config/types.tts.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { normalizeTtsAutoMode } from "./tts-auto-mode.js";
export { normalizeTtsAutoMode } from "./tts-auto-mode.js";

export function resolveConfiguredTtsMode(cfg: OpenClawConfig): TtsMode {
  return cfg.messages?.tts?.mode ?? "final";
}

function resolveTtsPrefsPathValue(prefsPath: string | undefined): string {
  if (prefsPath?.trim()) {
    return resolveUserPath(prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}

function readTtsPrefsAutoMode(prefsPath: string): TtsAutoMode | undefined {
  try {
    if (!existsSync(prefsPath)) {
      return undefined;
    }
    const prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as {
      tts?: { auto?: unknown; enabled?: unknown };
    };
    const auto = normalizeTtsAutoMode(prefs.tts?.auto);
    if (auto) {
      return auto;
    }
    if (typeof prefs.tts?.enabled === "boolean") {
      return prefs.tts.enabled ? "always" : "off";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function shouldAttemptTtsPayload(params: {
  cfg: OpenClawConfig;
  ttsAuto?: string;
}): boolean {
  const sessionAuto = normalizeTtsAutoMode(params.ttsAuto);
  if (sessionAuto) {
    return sessionAuto !== "off";
  }

  const raw = params.cfg.messages?.tts;
  const prefsAuto = readTtsPrefsAutoMode(resolveTtsPrefsPathValue(raw?.prefsPath));
  if (prefsAuto) {
    return prefsAuto !== "off";
  }

  const configuredAuto = normalizeTtsAutoMode(raw?.auto);
  if (configuredAuto) {
    return configuredAuto !== "off";
  }
  return raw?.enabled === true;
}

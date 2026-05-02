/**
 * OpenAI-compatible STT (Speech-to-Text) configuration and transcription.
 *
 * Migrated from `src/stt.ts` — uses core/utils/string-normalize instead
 * of openclaw/plugin-sdk/text-runtime.
 */

import * as fs from "node:fs";
import path from "node:path";
import {
  normalizeOptionalString,
  asOptionalObjectRecord as asRecord,
  readStringField as readString,
  sanitizeFileName,
} from "./string-normalize.js";

interface STTConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Resolve the STT configuration from the nested config object. */
export function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
  const channels = asRecord(cfg.channels);
  const qqbot = asRecord(channels?.qqbot);
  const channelStt = asRecord(qqbot?.stt);
  const models = asRecord(cfg.models);
  const providers = asRecord(models?.providers);

  // Prefer plugin-specific STT config.
  if (channelStt && channelStt.enabled !== false) {
    const providerId = readString(channelStt, "provider") ?? "openai";
    const providerCfg = asRecord(providers?.[providerId]);
    const baseUrl = readString(channelStt, "baseUrl") ?? readString(providerCfg, "baseUrl");
    const apiKey = readString(channelStt, "apiKey") ?? readString(providerCfg, "apiKey");
    const model = readString(channelStt, "model") ?? "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  // Fall back to framework-level audio model config.
  const tools = asRecord(cfg.tools);
  const media = asRecord(tools?.media);
  const audio = asRecord(media?.audio);
  const audioModels = audio?.models;
  const audioModelEntry = Array.isArray(audioModels) ? asRecord(audioModels[0]) : undefined;
  if (audioModelEntry) {
    const providerId = readString(audioModelEntry, "provider") ?? "openai";
    const providerCfg = asRecord(providers?.[providerId]);
    const baseUrl = readString(audioModelEntry, "baseUrl") ?? readString(providerCfg, "baseUrl");
    const apiKey = readString(audioModelEntry, "apiKey") ?? readString(providerCfg, "apiKey");
    const model = readString(audioModelEntry, "model") ?? "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  return null;
}

/** Send audio to an OpenAI-compatible STT endpoint and return the transcript. */
export async function transcribeAudio(
  audioPath: string,
  cfg: Record<string, unknown>,
): Promise<string | null> {
  const sttCfg = resolveSTTConfig(cfg);
  if (!sttCfg) {
    return null;
  }

  const fileBuffer = fs.readFileSync(audioPath);
  const fileName = sanitizeFileName(path.basename(audioPath));
  const mime = fileName.endsWith(".wav")
    ? "audio/wav"
    : fileName.endsWith(".mp3")
      ? "audio/mpeg"
      : fileName.endsWith(".ogg")
        ? "audio/ogg"
        : "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
  form.append("model", sttCfg.model);

  const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sttCfg.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = (await resp.json()) as { text?: string };
  return normalizeOptionalString(result.text) ?? null;
}

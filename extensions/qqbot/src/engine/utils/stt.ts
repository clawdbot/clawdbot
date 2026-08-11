/**
 * OpenAI-compatible STT (Speech-to-Text) configuration and transcription.
 *
 * Uses canonical Plugin SDK coercion helpers plus QQ-specific filename sanitization.
 */

import * as fs from "node:fs";
import path from "node:path";
import { mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import { finiteSecondsToTimerSafeMilliseconds } from "openclaw/plugin-sdk/number-runtime";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeOptionalString,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { readQqbotObjectRecord as asOptionalObjectRecord } from "../object-record.js";
import { sanitizeFileName } from "./string-normalize.js";

const STT_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const DEFAULT_STT_TIMEOUT_MS = 60_000;

interface STTConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

function resolveSTTTimeoutMs(...timeoutSeconds: unknown[]): number {
  for (const value of timeoutSeconds) {
    const timeoutMs = finiteSecondsToTimerSafeMilliseconds(value);
    if (timeoutMs !== undefined) {
      return timeoutMs;
    }
  }
  return DEFAULT_STT_TIMEOUT_MS;
}

/** Resolve the STT configuration from the nested config object. */
export function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
  const channels = asOptionalObjectRecord(cfg.channels);
  const qqbot = asOptionalObjectRecord(channels?.qqbot);
  const channelStt = asOptionalObjectRecord(qqbot?.stt);
  const models = asOptionalObjectRecord(cfg.models);
  const providers = asOptionalObjectRecord(models?.providers);

  // Prefer plugin-specific STT config.
  if (channelStt && channelStt.enabled !== false) {
    const providerId = readStringField(channelStt, "provider") ?? "openai";
    const providerCfg = asOptionalObjectRecord(providers?.[providerId]);
    const baseUrl =
      readStringField(channelStt, "baseUrl") ?? readStringField(providerCfg, "baseUrl");
    const apiKey = readStringField(channelStt, "apiKey") ?? readStringField(providerCfg, "apiKey");
    const model = readStringField(channelStt, "model") ?? "whisper-1";
    if (baseUrl && apiKey) {
      return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        apiKey,
        model,
        timeoutMs: resolveSTTTimeoutMs(providerCfg?.timeoutSeconds),
      };
    }
  }

  // Fall back to framework-level audio model config.
  const tools = asOptionalObjectRecord(cfg.tools);
  const media = asOptionalObjectRecord(tools?.media);
  const audio = asOptionalObjectRecord(media?.audio);
  const mediaModels = Array.isArray(media?.models) ? media.models : [];
  const audioModelEntry = mediaModels
    .map((entry) => asOptionalObjectRecord(entry))
    .find((entry) => !Array.isArray(entry?.capabilities) || entry.capabilities.includes("audio"));
  if (audioModelEntry) {
    const providerId = readStringField(audioModelEntry, "provider") ?? "openai";
    const providerCfg = asOptionalObjectRecord(providers?.[providerId]);
    const baseUrl =
      readStringField(audioModelEntry, "baseUrl") ?? readStringField(providerCfg, "baseUrl");
    const apiKey =
      readStringField(audioModelEntry, "apiKey") ?? readStringField(providerCfg, "apiKey");
    const model = readStringField(audioModelEntry, "model") ?? "whisper-1";
    if (baseUrl && apiKey) {
      return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        apiKey,
        model,
        timeoutMs: resolveSTTTimeoutMs(
          audioModelEntry.timeoutSeconds,
          audio?.timeoutSeconds,
          providerCfg?.timeoutSeconds,
        ),
      };
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
  const mime = mimeTypeFromFilePath(fileName) ?? "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
  form.append("model", sttCfg.model);

  const { response: resp, release } = await fetchWithSsrFGuard({
    url: `${sttCfg.baseUrl}/audio/transcriptions`,
    auditContext: "qqbot-stt",
    timeoutMs: sttCfg.timeoutMs,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${sttCfg.apiKey}` },
      body: form,
    },
  });
  try {
    if (!resp.ok) {
      const detail = await readResponseTextLimited(resp, STT_ERROR_BODY_LIMIT_BYTES).catch(
        () => "",
      );
      throw new Error(`STT failed (HTTP ${resp.status}): ${truncateUtf16Safe(detail, 300)}`);
    }

    const result = await readProviderJsonResponse<{ text?: string }>(resp, "qqbot.stt");
    return normalizeOptionalString(result.text) ?? null;
  } finally {
    await release();
  }
}

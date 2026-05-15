/**
 * Structured payload parsing and encoding for QQ Bot messages.
 *
 * Handles `QQBOT_PAYLOAD:` (model-emitted structured payloads) and
 * `QQBOT_CRON:` (persisted cron reminder payloads).
 *
 * Zero external dependencies.
 */

import type { ChatScope } from "../types.js";

/** Structured reminder payload emitted by the model. */
export interface CronReminderPayload {
  type: "cron_reminder";
  content: string;
  targetType: ChatScope;
  targetAddress: string;
  originalMessageId?: string;
}

/** Structured media payload emitted by the model. */
export interface MediaPayload {
  type: "media";
  mediaType: "image" | "audio" | "video" | "file";
  source: "url" | "file";
  path: string;
  caption?: string;
}

type QQBotPayload = CronReminderPayload | MediaPayload;

/** Result of parsing model output into a structured payload. */
interface ParseResult {
  isPayload: boolean;
  payload?: QQBotPayload;
  text?: string;
  error?: string;
}

const PAYLOAD_PREFIX = "QQBOT_PAYLOAD:";
const CRON_PREFIX = "QQBOT_CRON:";

function formatErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function normalizeBase64ForCompare(value: string): string {
  return value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
}

function decodeStrictBase64Utf8(value: string): string {
  const buffer = Buffer.from(value, "base64");
  if (normalizeBase64ForCompare(buffer.toString("base64")) !== normalizeBase64ForCompare(value)) {
    throw new Error("Cron payload body is not valid base64");
  }
  return buffer.toString("utf-8");
}

/** Parse model output that may start with the QQ Bot structured payload prefix. */
export function parseQQBotPayload(text: string): ParseResult {
  const trimmedText = text.trim();

  if (!trimmedText.startsWith(PAYLOAD_PREFIX)) {
    return { isPayload: false, text };
  }

  const jsonContent = trimmedText.slice(PAYLOAD_PREFIX.length).trim();

  if (!jsonContent) {
    return { isPayload: true, error: "Payload body is empty" };
  }

  try {
    const payload = JSON.parse(jsonContent) as QQBotPayload;

    if (!payload.type) {
      return { isPayload: true, error: "Payload is missing the type field" };
    }

    if (payload.type === "cron_reminder") {
      if (!payload.content || !payload.targetType || !payload.targetAddress) {
        return {
          isPayload: true,
          error:
            "cron_reminder payload is missing required fields (content, targetType, targetAddress)",
        };
      }
    } else if (payload.type === "media") {
      if (!payload.mediaType || !payload.source || !payload.path) {
        return {
          isPayload: true,
          error: "media payload is missing required fields (mediaType, source, path)",
        };
      }
    }

    return { isPayload: true, payload };
  } catch (e) {
    return { isPayload: true, error: `Failed to parse JSON: ${formatErr(e)}` };
  }
}

/** Encode a cron reminder payload into the stored cron-message format. */
export function encodePayloadForCron(payload: CronReminderPayload): string {
  const jsonString = JSON.stringify(payload);
  const base64 = Buffer.from(jsonString, "utf-8").toString("base64");
  return `${CRON_PREFIX}${base64}`;
}

/** Decode a stored cron payload. */
export function decodeCronPayload(message: string): {
  isCronPayload: boolean;
  payload?: CronReminderPayload;
  error?: string;
} {
  const trimmedMessage = message.trim();

  if (!trimmedMessage.startsWith(CRON_PREFIX)) {
    return { isCronPayload: false };
  }

  const base64Content = trimmedMessage.slice(CRON_PREFIX.length);

  if (!base64Content) {
    return { isCronPayload: true, error: "Cron payload body is empty" };
  }

  try {
    const jsonString = decodeStrictBase64Utf8(base64Content);
    const payload = JSON.parse(jsonString) as CronReminderPayload;

    if (payload.type !== "cron_reminder") {
      return {
        isCronPayload: true,
        error: `Expected type cron_reminder but got ${String(payload.type)}`,
      };
    }

    if (!payload.content || !payload.targetType || !payload.targetAddress) {
      return { isCronPayload: true, error: "Cron payload is missing required fields" };
    }

    return { isCronPayload: true, payload };
  } catch (e) {
    return { isCronPayload: true, error: `Failed to decode cron payload: ${formatErr(e)}` };
  }
}

/** Type guard for cron reminder payloads. */
export function isCronReminderPayload(payload: QQBotPayload): payload is CronReminderPayload {
  return payload.type === "cron_reminder";
}

/** Type guard for media payloads. */
export function isMediaPayload(payload: QQBotPayload): payload is MediaPayload {
  return payload.type === "media";
}

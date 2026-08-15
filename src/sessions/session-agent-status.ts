import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  SESSION_AGENT_ATTENTION_ICON_IDS,
  type SessionAgentAttentionIconId,
  type SessionAgentStatus,
} from "../../packages/gateway-protocol/src/session-agent-status.js";
import { renderUserFacingText } from "../agents/embedded-agent-helpers/user-facing-text.js";

const SESSION_AGENT_STATUS_NOTE_MAX_CHARS = 120;
const SESSION_AGENT_STATUS_DEFAULT_TTL_MINUTES = 30;
export const SESSION_AGENT_STATUS_MAX_TTL_MINUTES = 120;

const ATTENTION_ICON_IDS = new Set<string>(SESSION_AGENT_ATTENTION_ICON_IDS);
const SESSION_ICON_MAX_UTF16_UNITS = 16;
const ASCII_VISIBLE_CHARACTER_RE = /^[!-~]$/u;

export function normalizeSessionIconValue(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > SESSION_ICON_MAX_UTF16_UNITS) {
    return null;
  }
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(normalized),
  ];
  return graphemes.length === 1 && !ASCII_VISIBLE_CHARACTER_RE.test(normalized) ? normalized : null;
}

export function isSessionAgentAttentionIconId(
  value: unknown,
): value is SessionAgentAttentionIconId {
  return typeof value === "string" && ATTENTION_ICON_IDS.has(value);
}

export function sanitizeSessionAgentStatusNote(value: string): string {
  const normalized = renderUserFacingText(value, { errorContext: true })
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(normalized, SESSION_AGENT_STATUS_NOTE_MAX_CHARS).trimEnd();
}

export function resolveActiveSessionAgentStatus(
  status: SessionAgentStatus | undefined,
  now: number,
): SessionAgentStatus | undefined {
  if (
    !status ||
    !status.note.trim() ||
    !Number.isFinite(status.expiresAt) ||
    status.expiresAt <= now
  ) {
    return undefined;
  }
  if (status.attention !== undefined && !isSessionAgentAttentionIconId(status.attention)) {
    return undefined;
  }
  return status;
}

export function sessionAgentStatusExpiresAt(now: number, ttlMinutes?: number): number {
  const ttl = ttlMinutes ?? SESSION_AGENT_STATUS_DEFAULT_TTL_MINUTES;
  return now + ttl * 60_000;
}

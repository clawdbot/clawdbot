import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  SESSION_AGENT_ATTENTION_ICON_IDS,
  type SessionAgentAttentionIconId,
  type SessionAgentStatus,
} from "../../packages/gateway-protocol/src/session-icon.js";
import { sanitizeUserFacingText } from "../agents/embedded-agent-helpers/sanitize-user-facing-text.js";

const SESSION_AGENT_STATUS_NOTE_MAX_CHARS = 120;
const SESSION_AGENT_STATUS_DEFAULT_TTL_MINUTES = 30;
export const SESSION_AGENT_STATUS_MAX_TTL_MINUTES = 120;

const ATTENTION_ICON_IDS = new Set<string>(SESSION_AGENT_ATTENTION_ICON_IDS);

export function isSessionAgentAttentionIconId(
  value: unknown,
): value is SessionAgentAttentionIconId {
  return typeof value === "string" && ATTENTION_ICON_IDS.has(value);
}

export function sanitizeSessionAgentStatusNote(value: string): string {
  const normalized = sanitizeUserFacingText(value, { errorContext: true })
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

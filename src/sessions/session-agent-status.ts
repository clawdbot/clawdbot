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
// Anchored RGI_Emoji admits exactly one recommended-for-interchange emoji
// sequence (ZWJ families, flags, keycaps included) and nothing else. Construct
// it dynamically because the repository TypeScript target rejects literal `v` flags.
const SESSION_ICON_RE = new RegExp("^\\p{RGI_Emoji}$", "v");

export function normalizeSessionIconValue(value: string): string | null {
  const normalized = value.trim();
  return SESSION_ICON_RE.test(normalized) ? normalized : null;
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

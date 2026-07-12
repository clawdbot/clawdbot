// Control UI module implements session display behavior.
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "./string-coerce.ts";

const CHANNEL_LABELS: Record<string, string> = {
  imessage: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  slack: "Slack",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  email: "Email",
  sms: "SMS",
};

const KNOWN_CHANNEL_KEYS = Object.keys(CHANNEL_LABELS);

/** Human channel label for group headers and name fallbacks. */
export function channelDisplayLabel(channel: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(channel);
  return CHANNEL_LABELS[normalized] ?? capitalize(normalized || channel);
}

/** Raw peer ids stay out of the sidebar; keep a short recognizable tail only. */
function shortenPeerId(identifier: string): string {
  const trimmed = identifier.trim();
  return trimmed.length <= 10 ? trimmed : `…${trimmed.slice(-6)}`;
}

// Long hex/uuid runs inside keys and node ids are machine ids, not names;
// keep a short recognizable tail so rows never fill with opaque hashes.
const OPAQUE_ID_RUN_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{10,}/gi;

function shortenOpaqueIdRuns(text: string): string {
  return text.replace(OPAQUE_ID_RUN_RE, (match) => `…${match.slice(-4)}`);
}

const WORKTREE_BRANCH_PREFIX = "openclaw/";

const CHANNEL_SESSION_KEY_RE = /^agent:[^:]+:([^:]+)(?::[^:]+)?:(?:direct|group|channel|thread):/;
const PEER_SESSION_KEY_RE = /:(?:direct|group|channel|thread):/;

/**
 * Classifies channel-originated sessions for the sidebar's built-in channel
 * sections. Agent main and dashboard sessions stay out even when they carry
 * channel routing metadata (dmScope=main keeps Main as the anchor chat).
 */
export function resolveChannelSessionInfo(
  key: string,
  rowChannel?: string,
): { channel?: string; channelSession: boolean } {
  if (!PEER_SESSION_KEY_RE.test(key)) {
    return { channelSession: false };
  }
  const keyChannel = key.match(CHANNEL_SESSION_KEY_RE)?.[1];
  const channel =
    normalizeOptionalString(keyChannel && keyChannel !== "direct" ? keyChannel : undefined) ??
    normalizeOptionalString(rowChannel);
  return { channel, channelSession: Boolean(channel) };
}

type SessionWorktreeDisplayRow = {
  worktree?: { branch?: string; repoRoot?: string };
  execNode?: string;
};

/** Compact "repo ⎇ branch" (plus node host) line for worktree/work sessions. */
export function resolveSessionWorkSubtitle(row: SessionWorktreeDisplayRow): string | undefined {
  const repoRoot = normalizeOptionalString(row.worktree?.repoRoot);
  const branch = normalizeOptionalString(row.worktree?.branch);
  // execNode is often a raw node id (long hex); never render it in full.
  const rawNode = normalizeOptionalString(row.execNode);
  const node = rawNode ? shortenOpaqueIdRuns(rawNode) : undefined;
  const repoName = repoRoot ? (repoRoot.split(/[\\/]/).findLast(Boolean) ?? repoRoot) : undefined;
  const shortBranch = branch?.startsWith(WORKTREE_BRANCH_PREFIX)
    ? branch.slice(WORKTREE_BRANCH_PREFIX.length)
    : branch;
  const checkout = repoName ? (shortBranch ? `${repoName} ⎇ ${shortBranch}` : repoName) : undefined;
  if (checkout && node) {
    // Checkout first: it names the work; the node is routing detail.
    return `${checkout} · ${node}`;
  }
  return checkout ?? node;
}

/** Parsed type / context extracted from a session key. */
type SessionKeyInfo = {
  /** Prefix for typed sessions (Subagent:/Cron:). Empty for others. */
  prefix: string;
  /** Human-readable fallback when no label / displayName is available. */
  fallbackName: string;
};

type SessionDisplayRow = {
  label?: string;
  displayName?: string;
} & SessionWorktreeDisplayRow;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse a session key to extract type information and a human-readable
 * fallback display name. Exported for testing.
 */
function parseSessionKey(key: string): SessionKeyInfo {
  const normalized = normalizeLowercaseStringOrEmpty(key);

  // Main session.
  if (key === "main" || key === "agent:main:main") {
    return { prefix: "", fallbackName: "Main Session" };
  }

  // Subagent.
  if (key.includes(":subagent:")) {
    return { prefix: "Subagent:", fallbackName: "Subagent:" };
  }

  // Cron job.
  if (normalized.startsWith("cron:") || key.includes(":cron:")) {
    return { prefix: "Cron:", fallbackName: "Cron Job:" };
  }

  // Direct chat: agent:<x>:<channel>:direct:<id>. Never render the raw peer
  // id; the gateway sends origin-derived names, so this is a last resort.
  const directMatch = key.match(/^agent:[^:]+:([^:]+):direct:(.+)$/);
  if (directMatch) {
    const channel = directMatch[1];
    const identifier = directMatch[2];
    if (!channel || !identifier) {
      return { prefix: "", fallbackName: key };
    }
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} · ${shortenPeerId(identifier)}` };
  }

  // Group chat: agent:<x>:<channel>:group:<id>.
  const groupMatch = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (groupMatch) {
    const channel = groupMatch[1];
    if (!channel) {
      return { prefix: "", fallbackName: key };
    }
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} Group` };
  }

  // Channel-prefixed keys like "telegram:123": durable session rows written by
  // pre-agent-scoped builds still surface in session lists; label, don't leak keys.
  for (const ch of KNOWN_CHANNEL_KEYS) {
    if (key === ch || key.startsWith(`${ch}:`)) {
      return { prefix: "", fallbackName: `${CHANNEL_LABELS[ch]} Session` };
    }
  }

  // Dashboard sessions get generated titles asynchronously; the opaque uuid key
  // must not flash in the sidebar while that title is pending.
  if (/^agent:[^:]+:dashboard:/.test(key)) {
    return { prefix: "", fallbackName: "New session" };
  }

  // Remaining agent keys are named subsessions (CLI --session-id and friends):
  // drop the agent:<id>: routing boilerplate and shorten opaque id runs so the
  // slug reads as a name instead of a raw key.
  const agentKeyMatch = key.match(/^agent:[^:]+:(?:explicit:)?(.+)$/);
  const agentKeyName = agentKeyMatch?.[1];
  if (agentKeyName) {
    return { prefix: "", fallbackName: shortenOpaqueIdRuns(agentKeyName) };
  }

  // Unknown: return key as-is.
  return { prefix: "", fallbackName: key };
}

export function resolveSessionDisplayName(key: string, row?: SessionDisplayRow): string {
  const label = normalizeOptionalString(row?.label) ?? "";
  const displayName = normalizeOptionalString(row?.displayName) ?? "";
  const { prefix, fallbackName } = parseSessionKey(key);

  const applyTypedPrefix = (name: string): string => {
    if (!prefix) {
      return name;
    }
    const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*`, "i");
    return prefixPattern.test(name) ? name : `${prefix} ${name}`;
  };

  if (label && label !== key) {
    return applyTypedPrefix(label);
  }
  if (displayName && displayName !== key) {
    return applyTypedPrefix(displayName);
  }
  // Unnamed work sessions read as their checkout instead of an opaque key.
  const workSubtitle = row ? resolveSessionWorkSubtitle(row) : undefined;
  if (workSubtitle && row?.worktree) {
    return applyTypedPrefix(workSubtitle);
  }
  return fallbackName;
}

export function isCronSessionKey(key: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(key);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("cron:")) {
    return true;
  }
  if (!normalized.startsWith("agent:")) {
    return false;
  }
  const parts = normalized.split(":").filter(Boolean);
  if (parts.length < 3) {
    return false;
  }
  const rest = parts.slice(2).join(":");
  return rest.startsWith("cron:");
}

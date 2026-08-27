import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
// Control UI module implements session display behavior.
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { t } from "../i18n/index.ts";

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

/** Raw peer ids stay out of the sidebar; keep a short recognizable tail only. */
function shortenPeerId(identifier: string): string {
  const trimmed = identifier.trim();
  return trimmed.length <= 10 ? trimmed : `…${sliceUtf16Safe(trimmed, -6)}`;
}

// Long hex/uuid runs inside keys and node ids are machine ids, not names;
// keep a short recognizable tail so rows never fill with opaque hashes.
const OPAQUE_ID_RUN_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{10,}/gi;

function shortenOpaqueIdRuns(text: string): string {
  return text.replace(OPAQUE_ID_RUN_RE, (match) => `…${match.slice(-4)}`);
}

const WORKTREE_BRANCH_PREFIX = "openclaw/";

// `dm` is the pre-#11881 spelling of `direct`; those keys still persist and the
// canonical parser still accepts both (src/sessions/session-key-utils.ts).
// Only direct chats take an account segment (src/routing/session-key.ts), so an
// account-qualified group or channel key is not a shape any producer emits and
// must not name a channel here either.
const CHANNEL_SESSION_KEY_RE =
  /^agent:[^:]+:([^:]+)(?:(?::[^:]+)?:(?:direct|dm)|:(?:group|channel|thread)):/;
const PEER_SESSION_KEY_RE = /:(?:direct|dm|group|channel|thread):/;

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
  const channel = normalizeOptionalString(keyChannel) ?? normalizeOptionalString(rowChannel);
  return { channel, channelSession: Boolean(channel) };
}

type SessionWorktreeDisplayRow = {
  worktree?: { branch?: string; repoRoot?: string };
  execNode?: string;
  execCwd?: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
};

export type SessionWorkContext =
  | { kind: "project"; name: string; path: string; branch?: string }
  | { kind: "workspace"; name: string; path: string };

/** Basename shown for a repository path on every Control UI surface. */
export function repoName(repoRoot: string): string {
  return repoRoot.split(/[\\/]/).findLast(Boolean) ?? repoRoot;
}

export function resolveSessionWorkContext(
  row: SessionWorktreeDisplayRow,
): SessionWorkContext | undefined {
  if (row.execNode) {
    const workspacePath = normalizeOptionalString(row.execCwd);
    return workspacePath
      ? { kind: "workspace", name: repoName(workspacePath), path: workspacePath }
      : undefined;
  }
  const repoRoot = normalizeOptionalString(row.worktree?.repoRoot);
  if (repoRoot) {
    const branch = normalizeOptionalString(row.worktree?.branch);
    return {
      kind: "project",
      name: repoName(repoRoot),
      path: repoRoot,
      branch: branch?.startsWith(WORKTREE_BRANCH_PREFIX)
        ? branch.slice(WORKTREE_BRANCH_PREFIX.length)
        : branch,
    };
  }

  // Match the chat workspace owner: local spawned sessions own their recorded
  // workspace first, then their spawned cwd.
  const workspacePath =
    normalizeOptionalString(row.spawnedWorkspaceDir) ?? normalizeOptionalString(row.spawnedCwd);
  if (!workspacePath) {
    return undefined;
  }
  return {
    kind: "workspace",
    name: repoName(workspacePath),
    path: workspacePath,
  };
}

/** Compact "repo ⎇ branch" (plus node host) line for worktree/work sessions. */
export function resolveSessionWorkSubtitle(row: SessionWorktreeDisplayRow): string | undefined {
  // execNode is often a raw node id (long hex); never render it in full.
  const rawNode = normalizeOptionalString(row.execNode);
  const node = rawNode ? shortenOpaqueIdRuns(rawNode) : undefined;
  const repoRoot = normalizeOptionalString(row.worktree?.repoRoot);
  const rawBranch = normalizeOptionalString(row.worktree?.branch);
  const branch = rawBranch?.startsWith(WORKTREE_BRANCH_PREFIX)
    ? rawBranch.slice(WORKTREE_BRANCH_PREFIX.length)
    : rawBranch;
  const checkout = repoRoot
    ? branch
      ? `${repoName(repoRoot)} ⎇ ${branch}`
      : repoName(repoRoot)
    : undefined;
  if (checkout && node) {
    // Checkout first: it names the work; the node is routing detail.
    return `${checkout} · ${node}`;
  }
  return checkout ?? node;
}

/** Machine identity of a typed session, derived from the session key. */
type SessionTypedKind = "subagent" | "automation";

/** Parsed type / context extracted from a session key. */
type SessionKeyInfo = {
  /** Typed-session identity; display branching keys off this, not label text. */
  kind?: SessionTypedKind;
  /** Catalog-backed prefix for typed sessions. Empty for others. */
  prefix: string;
  /** Human-readable fallback when no label / displayName is available. */
  fallbackName: string;
  /** Raw account segment; only a fallback, Gateway rows carry the real one. */
  accountId?: string;
};

/**
 * Two DMs from different accounts routinely share a name, so the account is the
 * only discriminator; `default` is what key builders write for absence and says
 * nothing. Which account to show comes from the recorded fact alone, never from
 * the rendered name. The suffix check preserves labels persisted by older
 * clients that included this decoration, avoiding `Alice · cards · cards`.
 */
function withAccountDisambiguator(name: string, accountId: string | undefined): string {
  if (!accountId || accountId === "default") {
    return name;
  }
  const suffix = ` · ${accountId}`;
  return name.endsWith(suffix) ? name : `${name}${suffix}`;
}

/** Typed-session prefixes come from the i18n catalog (RFC 0026). */
function typedSessionPrefix(kind: SessionTypedKind): string {
  return kind === "subagent"
    ? t("sessionsView.subagentPrefix")
    : t("sessionsView.automationPrefix");
}

type SessionDisplayRow = {
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  /** Canonical account projected from the delivery route by the Gateway. */
  accountId?: string;
} & SessionWorktreeDisplayRow;

type SessionDisplayOptions = {
  includeSubagentPrefix?: boolean;
};

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
  if (key === "main" || /^agent:[^:]+:main$/u.test(key)) {
    return { prefix: "", fallbackName: "Main Session" };
  }

  // Subagent.
  if (key.includes(":subagent:")) {
    const prefix = typedSessionPrefix("subagent");
    return { kind: "subagent", prefix, fallbackName: prefix };
  }

  // Automation (cron) job. Session keys keep the `cron:` prefix; only the
  // display strings use the Automations feature name.
  if (normalized.startsWith("cron:") || key.includes(":cron:")) {
    const prefix = typedSessionPrefix("automation");
    return { kind: "automation", prefix, fallbackName: prefix };
  }

  // Direct chat: agent:<x>:<channel>[:<account>]:(direct|dm):<id>. Never render
  // the raw peer id; the gateway sends origin-derived names, so this is a last
  // resort.
  const directMatch = key.match(/^agent:[^:]+:([^:]+)(?::([^:]+))?:(?:direct|dm):(.+)$/);
  if (directMatch) {
    const channel = directMatch[1];
    const accountId = directMatch[2];
    const identifier = directMatch[3];
    if (!channel || !identifier) {
      return { prefix: "", fallbackName: key, accountId };
    }
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return {
      prefix: "",
      fallbackName: `${channelLabel} · ${shortenPeerId(identifier)}`,
      accountId,
    };
  }

  // Group chat: agent:<x>:<channel>:group:<id>. buildAgentPeerSessionKey scopes
  // accounts to DMs (src/routing/session-key.ts), so an account-looking segment
  // here belongs to a custom key and must not be read as one.
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

export function resolveSessionDisplayName(
  key: string,
  row?: SessionDisplayRow,
  options: SessionDisplayOptions = {},
): string {
  const label = normalizeOptionalString(row?.label) ?? "";
  const displayName = normalizeOptionalString(row?.displayName) ?? "";
  const derivedTitle = normalizeOptionalString(row?.derivedTitle) ?? "";
  const { kind, prefix, fallbackName, accountId: keyAccountId } = parseSessionKey(key);
  // The Gateway records the account on the row (src/gateway/session-classification.ts);
  // the key is parsed only for panes rendered before their row arrives.
  const accountId = normalizeOptionalString(row?.accountId) ?? keyAccountId;

  const applyTypedPrefix = (rawName: string): string => {
    if (!kind || !prefix) {
      return rawName;
    }
    // Persisted automation sessions carry pre-rename "Cron:"/"Cron Job:"
    // labels; strip them so the renamed prefix does not double up as
    // "Automation: Cron: …".
    const name =
      kind === "automation"
        ? rawName.replace(/^cron(\s+job)?:\s*/i, "").trim() || rawName
        : rawName;
    const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*`, "i");
    if (kind === "subagent" && options.includeSubagentPrefix === false) {
      return name.replace(prefixPattern, "").trim() || fallbackName;
    }
    return prefixPattern.test(name) ? name : `${prefix} ${name}`;
  };

  const resolveNamedOrFallback = (): string => {
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
    if (derivedTitle && derivedTitle !== key) {
      return applyTypedPrefix(derivedTitle);
    }
    return fallbackName;
  };

  return withAccountDisambiguator(resolveNamedOrFallback(), accountId);
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

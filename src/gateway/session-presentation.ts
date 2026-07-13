/** Builds client-ready, non-sensitive presentation metadata for Gateway session rows. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type {
  SessionPresentation,
  SessionPresentationFamily,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey, parseSessionDeliveryRoute } from "../routing/session-key.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";

const OPAQUE_ID_RUN_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{10,}/gi;
const OPAQUE_ID_PRESENT_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{10,}/i;

const BACKGROUND_FAMILIES = new Set<SessionPresentationFamily>([
  "acp",
  "cron",
  "dreaming",
  "harness",
  "heartbeat",
  "hook",
  "subagent",
  "system",
]);

function capitalize(value: string): string {
  return value.length > 0 ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function shortenOpaqueIdRuns(value: string): string {
  return value.replace(OPAQUE_ID_RUN_RE, (match) => `…${match.slice(-4)}`);
}

function normalizeTitle(value: string | undefined, key: string): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && normalized !== key ? normalized : undefined;
}

function normalizeDisplayName(value: string | undefined, key: string): string | undefined {
  const normalized = normalizeTitle(value, key);
  return normalized && !OPAQUE_ID_PRESENT_RE.test(normalized) ? normalized : undefined;
}

function formatWorktree(worktree: SessionEntry["worktree"]): string | undefined {
  if (!worktree) {
    return undefined;
  }
  const repoRoot = normalizeOptionalString(worktree.repoRoot);
  const branch = normalizeOptionalString(worktree.branch);
  const repo = repoRoot?.split(/[\\/]/).findLast(Boolean);
  const shortBranch = branch?.startsWith("openclaw/") ? branch.slice("openclaw/".length) : branch;
  if (repo && shortBranch) {
    return `${repo} ⎇ ${shortBranch}`;
  }
  return repo ?? shortBranch;
}

function customTitle(rest: string): string {
  const explicit = rest.startsWith("explicit:") ? rest.slice("explicit:".length) : rest;
  return shortenOpaqueIdRuns(explicit) || "Session";
}

function fallbackTitle(params: {
  family: SessionPresentationFamily;
  rest: string;
  channel?: string;
  worktree?: SessionEntry["worktree"];
}): string {
  const channel = params.channel ? capitalize(params.channel) : undefined;
  switch (params.family) {
    case "main":
      return "Main session";
    case "global":
      return "Global session";
    case "unknown":
      return "Unknown session";
    case "direct":
      return channel ? `${channel} direct message` : "Direct message";
    case "group":
      return channel ? `${channel} group` : "Group conversation";
    case "channel":
      return channel ? `${channel} channel` : "Channel conversation";
    case "thread":
      return channel ? `${channel} thread` : "Thread";
    case "cron":
      return "Scheduled task";
    case "heartbeat":
      return "Heartbeat";
    case "subagent":
      return "Subagent";
    case "acp":
      return "ACP session";
    case "dashboard":
      return formatWorktree(params.worktree) ?? "New session";
    case "tui":
      return "Terminal session";
    case "explicit":
      return customTitle(params.rest);
    case "hook":
      return "Hook run";
    case "harness":
      return "Harness session";
    case "voice":
      return "Voice call";
    case "dreaming":
      return "Dreaming";
    case "system":
      return "Background task";
    case "custom":
      return "Session";
  }
}

function classifyRest(rest: string): SessionPresentationFamily {
  const normalized = normalizeLowercaseStringOrEmpty(rest);
  if (normalized.startsWith("dashboard:")) return "dashboard";
  if (normalized.startsWith("tui-")) return "tui";
  if (normalized.startsWith("explicit:")) return "explicit";
  if (normalized.startsWith("hook:")) return "hook";
  if (normalized.startsWith("harness:")) return "harness";
  if (normalized.startsWith("voice:")) return "voice";
  if (normalized.startsWith("dreaming-narrative-")) return "dreaming";
  if (
    normalized === "boot" ||
    normalized.startsWith("commitments:") ||
    normalized.startsWith("internal-session-effects:")
  ) {
    return "system";
  }
  return "custom";
}

/**
 * Build the presentation contract without exposing peer ids, transcript text,
 * absolute paths, or other data that is not already a session-list field.
 */
export function buildGatewaySessionPresentation(params: {
  key: string;
  agentId?: string;
  displayName?: string;
  entry?: SessionEntry;
  isMain: boolean;
}): SessionPresentation {
  const { key, entry } = params;
  const parsedAgent = parseAgentSessionKey(key);
  const agentId = parsedAgent?.agentId ?? normalizeOptionalString(params.agentId);
  const rest = parsedAgent?.rest ?? key;
  const parsedThread = parseThreadSessionSuffix(key);
  const route = parseSessionDeliveryRoute(key);
  const perPeerKind = /^((?:direct|dm)):(.+)$/i.exec(
    parseAgentSessionKey(parsedThread.baseSessionKey)?.rest ?? "",
  )?.[1];

  let family: SessionPresentationFamily;
  if (key === "global") {
    family = "global";
  } else if (key === "unknown") {
    family = "unknown";
  } else if (entry?.heartbeatIsolatedBaseSessionKey) {
    family = "heartbeat";
  } else if (params.isMain) {
    family = "main";
  } else if (isSubagentSessionKey(key)) {
    family = "subagent";
  } else if (isAcpSessionKey(key)) {
    family = "acp";
  } else if (isCronSessionKey(key)) {
    family = "cron";
  } else if (parsedThread.threadId) {
    family = "thread";
  } else if (route?.peerKind === "group") {
    family = "group";
  } else if (route?.peerKind === "channel") {
    family = "channel";
  } else if (route?.peerKind === "direct" || route?.peerKind === "dm" || perPeerKind) {
    family = "direct";
  } else if (
    entry?.chatType === "direct" ||
    entry?.chatType === "group" ||
    entry?.chatType === "channel"
  ) {
    family = entry.chatType;
  } else {
    family = classifyRest(rest);
  }

  const channel = entry?.channel ?? route?.channel;
  const accountId = route?.accountId;
  const peerKind = route?.peerKind
    ? route.peerKind === "dm"
      ? "direct"
      : route.peerKind
    : perPeerKind
      ? "direct"
      : undefined;
  const label = normalizeTitle(entry?.label, key);
  const displayName = normalizeDisplayName(params.displayName, key);
  const title =
    label ?? displayName ?? fallbackTitle({ family, rest, channel, worktree: entry?.worktree });
  const titleSource = label
    ? "label"
    : displayName
      ? "displayName"
      : family === "dashboard" && formatWorktree(entry?.worktree)
        ? "worktree"
        : "generated";

  const subtitleParts: string[] = [];
  if (channel) subtitleParts.push(capitalize(channel));
  if (accountId) subtitleParts.push(`account ${shortenOpaqueIdRuns(accountId)}`);
  if (agentId) subtitleParts.push(`agent ${shortenOpaqueIdRuns(agentId)}`);

  return {
    title,
    titleSource,
    ...(subtitleParts.length > 0 ? { subtitle: subtitleParts.join(" · ") } : {}),
    family,
    ...(agentId ? { agentId } : {}),
    ...(channel ? { channel } : {}),
    ...(accountId ? { accountId } : {}),
    ...(peerKind ? { peerKind } : {}),
    isMain: params.isMain,
    isBackground: BACKGROUND_FAMILIES.has(family),
  };
}

export function sessionPresentationForRow(
  cfg: OpenClawConfig,
  key: string,
  agentId: string,
  displayName?: string,
  entry?: SessionEntry,
): SessionPresentation {
  const isMain =
    key === "global"
      ? cfg.session?.scope === "global"
      : key === resolveAgentMainSessionKey({ cfg, agentId });
  return buildGatewaySessionPresentation({ key, agentId, displayName, entry, isMain });
}

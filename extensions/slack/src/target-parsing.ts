// Slack plugin module implements target parsing behavior.
import {
  buildMessagingTarget,
  ensureTargetId,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind,
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
} from "openclaw/plugin-sdk/channel-targets";

export type SlackTargetKind = MessagingTargetKind;

export type SlackTarget = MessagingTarget & {
  teamId?: string;
};

export type SlackTargetParseOptions = MessagingTargetParseOptions;

// Letter-leading folded IDs are indistinguishable from supported channel names.
// Doctor reports that ambiguity; runtime repairs only the digit-leading form.
const SLACK_CHANNEL_API_ID_RE = /^[CDG][0-9][A-Z0-9]{7,}$/i;
const SLACK_USER_API_ID_RE = /^[UW][A-Z0-9]{8,}$/i;
const SLACK_QUALIFIED_TARGET_RE = /^team:([^:]+):(user|channel):([^:]+)$/i;

function decodeSlackTargetPart(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw).trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseQualifiedSlackTarget(raw: string): SlackTarget | undefined {
  const match = SLACK_QUALIFIED_TARGET_RE.exec(raw);
  if (!match) {
    if (/^team:/i.test(raw)) {
      throw new Error(
        "Slack workspace targets require team:<team-id>:channel:<channel-id> or team:<team-id>:user:<user-id>",
      );
    }
    return undefined;
  }
  const teamId = decodeSlackTargetPart(match[1] ?? "");
  const kind = match[2]?.toLowerCase() as SlackTargetKind | undefined;
  const id = decodeSlackTargetPart(match[3] ?? "");
  const idPattern = kind === "user" ? /^[UW][A-Z0-9]+$/i : /^[CDG][A-Z0-9]+$/i;
  if (!teamId || !/^T[A-Z0-9]+$/i.test(teamId) || !kind || !id || !idPattern.test(id)) {
    throw new Error("Invalid Slack workspace-qualified target");
  }
  return {
    kind,
    id,
    teamId,
    raw,
    normalized: `team:${teamId.toLowerCase()}:${kind}:${id.toLowerCase()}`,
  };
}

export function formatSlackTarget(params: {
  teamId?: string;
  kind: SlackTargetKind;
  id: string;
  explicitKind?: boolean;
}): string {
  const teamId = params.teamId?.trim();
  const id = params.id.trim();
  if (!teamId) {
    return params.explicitKind ? `${params.kind}:${id}` : id;
  }
  const idPattern = params.kind === "user" ? /^[UW][A-Z0-9]+$/i : /^[CDG][A-Z0-9]+$/i;
  if (!/^T[A-Z0-9]+$/i.test(teamId) || !idPattern.test(id)) {
    throw new Error("Invalid Slack workspace-qualified target");
  }
  return `team:${encodeURIComponent(teamId)}:${params.kind}:${encodeURIComponent(id)}`;
}

function isUnambiguousSlackUserId(rawId: string): boolean {
  const id = rawId.trim();
  return /^[UW][A-Z0-9]+$/.test(id) || /^[uw][0-9][a-z0-9]{7,}$/.test(id);
}

/** Restores API casing for unambiguous normalized Slack conversation IDs. */
export function canonicalizeSlackApiTargetId(
  kind: SlackTargetKind,
  rawId: string,
  rawTarget?: string,
): string {
  const id = rawId.trim();
  if (kind === "channel" && rawTarget?.trim().startsWith("#")) {
    return id;
  }
  const idPattern = kind === "user" ? SLACK_USER_API_ID_RE : SLACK_CHANNEL_API_ID_RE;
  return idPattern.test(id) ? id.toUpperCase() : id;
}

export function parseSlackTarget(
  raw: string,
  options: SlackTargetParseOptions = {},
): SlackTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const qualifiedTarget = parseQualifiedSlackTarget(trimmed);
  if (qualifiedTarget) {
    return qualifiedTarget;
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    raw: trimmed,
    mentionPattern: /^<@([A-Z0-9]+)>$/i,
    prefixes: [
      { prefix: "user:", kind: "user" },
      { prefix: "channel:", kind: "channel" },
      { prefix: "slack:", kind: "user" },
    ],
    atUserPattern: /^[A-Z0-9]+$/i,
    atUserErrorMessage: "Slack DMs require a user id (use user:<id> or <@id>)",
  });
  if (userTarget) {
    return userTarget;
  }
  if (trimmed.startsWith("#")) {
    const candidate = trimmed.slice(1).trim();
    const id = ensureTargetId({
      candidate,
      pattern: /^[A-Z0-9]+$/i,
      errorMessage: "Slack channels require a channel id (use channel:<id>)",
    });
    return buildMessagingTarget("channel", id, trimmed);
  }
  if (isUnambiguousSlackUserId(trimmed)) {
    return buildMessagingTarget("user", trimmed, trimmed);
  }
  if (options.defaultKind) {
    return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}

export function resolveSlackChannelId(raw: string): string {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  const channelId = requireTargetKind({ platform: "Slack", target, kind: "channel" });
  return canonicalizeSlackApiTargetId("channel", channelId, raw);
}

export function normalizeSlackMessagingTarget(raw: string): string | undefined {
  return parseSlackTarget(raw, { defaultKind: "channel" })?.normalized;
}

export function slackTargetsMatch(left: string, right: string): boolean {
  const leftTarget = normalizeSlackMessagingTarget(left);
  const rightTarget = normalizeSlackMessagingTarget(right);
  return Boolean(leftTarget && rightTarget && leftTarget === rightTarget);
}

export function looksLikeSlackTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^<@([A-Z0-9]+)>$/i.test(trimmed)) {
    return true;
  }
  if (/^(user|channel):/i.test(trimmed)) {
    return true;
  }
  if (/^slack:/i.test(trimmed)) {
    return true;
  }
  if (/^team:/i.test(trimmed)) {
    return true;
  }
  if (/^[@#]/.test(trimmed)) {
    return true;
  }
  return /^[CUWGD][A-Z0-9]{8,}$/i.test(trimmed);
}

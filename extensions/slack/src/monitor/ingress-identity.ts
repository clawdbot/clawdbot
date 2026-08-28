import {
  defineStableChannelIngressIdentity,
  type ChannelIngressIdentifierKind,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseSlackTarget } from "../target-parsing.js";
import { normalizeSlackSlug } from "./allow-list.js";

export const SLACK_USER_NAME_KIND =
  "plugin:slack-user-name" as const satisfies ChannelIngressIdentifierKind;
const SLACK_WORKSPACE_USER_ID_KIND =
  "plugin:slack-workspace-user-id" as const satisfies ChannelIngressIdentifierKind;

function normalizeSlackUserId(raw?: string | null): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) {
    return "";
  }
  const mention = value.match(/^<@([a-z0-9_]+)>$/i);
  if (mention?.[1]) {
    return mention[1];
  }
  return value.replace(/^(slack:|user:)/, "");
}

function isSlackStableUserId(value: string): boolean {
  return /^[ubw][a-z0-9_]+$/i.test(value);
}

function normalizeSlackWorkspaceUserEntry(entry: string): string | null {
  const normalized = entry.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  try {
    const target = parseSlackTarget(normalized);
    if (target?.kind === "user" && target.teamId) {
      return target.normalized;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeSlackBareUserEntry(entry: string): string | null {
  const normalized = entry.trim().toLowerCase();
  if (!normalized || normalizeSlackWorkspaceUserEntry(normalized)) {
    return null;
  }
  const userId = normalizeSlackUserId(normalized);
  return isSlackStableUserId(userId) ? userId : null;
}

function normalizeSlackStableEntry(entry: string): string | null {
  return normalizeSlackBareUserEntry(entry) ?? normalizeSlackWorkspaceUserEntry(entry);
}

function normalizeSlackNameEntry(entry: string): string | null {
  const normalized = entry.trim().toLowerCase();
  if (!normalized || normalizeSlackStableEntry(normalized)) {
    return null;
  }
  return normalized.replace(/^slack:/, "") || null;
}

function normalizeSlackNameSubject(value: string): string | null {
  return value.trim().toLowerCase() || null;
}

function normalizeSlackNameSlugEntry(entry: string): string | null {
  const name = normalizeSlackNameEntry(entry);
  if (!name) {
    return null;
  }
  return normalizeSlackSlug(name) || null;
}

export const slackIngressIdentity = defineStableChannelIngressIdentity({
  key: "senderId",
  kind: "stable-id",
  // Direct Slack transports bind this id, while relay mode only authenticates its relay peer.
  // The shared declaration therefore uses the strongest claim defensible for every mode.
  authentication: "asserted",
  normalizeEntry: normalizeSlackBareUserEntry,
  normalizeSubject: normalizeSlackUserId,
  sensitivity: "pii",
  aliases: [
    {
      key: "workspaceSenderId",
      kind: SLACK_WORKSPACE_USER_ID_KIND,
      authentication: "asserted",
      normalizeEntry: normalizeSlackWorkspaceUserEntry,
      normalizeSubject: normalizeSlackWorkspaceUserEntry,
      sensitivity: "pii",
    },
    ...(
      [
        ["senderName", normalizeSlackNameEntry],
        ["senderNameSlug", normalizeSlackNameSlugEntry],
      ] as const
    ).map(([key, normalizeEntry]) => ({
      key,
      kind: SLACK_USER_NAME_KIND,
      normalizeEntry,
      normalizeSubject: normalizeSlackNameSubject,
      authentication: "mutable" as const,
      sensitivity: "pii" as const,
    })),
  ],
});

export function createSlackIngressSubject(params: {
  senderId: string;
  senderName?: string;
  teamId?: string;
}) {
  const senderId = normalizeSlackUserId(params.senderId);
  const teamId = normalizeOptionalLowercaseString(params.teamId);
  const senderName = params.senderName?.trim().toLowerCase();
  const senderNameSlug = senderName ? normalizeSlackSlug(senderName) : undefined;
  return {
    stableId: senderId,
    aliases: {
      workspaceSenderId: teamId && senderId ? `team:${teamId}:user:${senderId}` : undefined,
      senderName,
      senderNameSlug,
    },
  };
}

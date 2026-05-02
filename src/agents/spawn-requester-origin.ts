import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveFirstBoundAccountId } from "../routing/bound-account-read.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";

// Delivery targets often carry a transport wrapper (e.g. Matrix `room:<id>` or
// LINE `line:group:<id>`), while route bindings commonly store raw peer ids on
// `match.peer.id`. Peel wrappers for those lookups, and separately pass the
// original target as an exact-match alias for channels whose canonical peer ids
// intentionally include prefixes such as `channel:` or `thread:`.
const KIND_PREFIX_TO_CHAT_TYPE: Readonly<Record<string, ChatType>> = {
  "room:": "channel",
  "channel:": "channel",
  "conversation:": "channel",
  "chat:": "channel",
  "thread:": "channel",
  "topic:": "channel",
  "group:": "group",
  "team:": "group",
  "user:": "direct",
  "dm:": "direct",
  "pm:": "direct",
};

// Matches one leading `<alpha-token>:` wrapper at a time.
const GENERIC_PREFIX_PATTERN = /^[a-z][a-z0-9_-]*:/i;

function getKindForRequesterPrefix(prefix: string): ChatType | undefined {
  return Object.hasOwn(KIND_PREFIX_TO_CHAT_TYPE, prefix)
    ? KIND_PREFIX_TO_CHAT_TYPE[prefix]
    : undefined;
}

function normalizeChannelPrefix(channelId: string | undefined): string | undefined {
  const normalized = channelId?.trim().toLowerCase();
  return normalized ? `${normalized}:` : undefined;
}

function shouldPeelRequesterPrefix(prefix: string, channelPrefix: string | undefined): boolean {
  return Boolean(getKindForRequesterPrefix(prefix) || prefix === channelPrefix);
}

function inferPeerKindFromBareId(value: string): ChatType | undefined {
  if (value.startsWith("@")) {
    return "direct";
  }
  if (value.startsWith("!") || value.startsWith("#")) {
    return "channel";
  }
  return undefined;
}

function extractRequesterPeer(
  channelId: string | undefined,
  requesterTo: string | undefined,
): { peerId?: string; peerKind?: ChatType } {
  if (!requesterTo) {
    return {};
  }
  const raw = requesterTo.trim();
  if (!raw) {
    return {};
  }
  const channelPrefix = normalizeChannelPrefix(channelId);
  let inferredKind: ChatType | undefined;
  let allowBareIdKindOverride = false;
  let value = raw;
  while (true) {
    const match = GENERIC_PREFIX_PATTERN.exec(value);
    if (!match) {
      break;
    }
    const prefix = match[0].toLowerCase();
    if (!shouldPeelRequesterPrefix(prefix, channelPrefix)) {
      break;
    }
    const kindFromPrefix = getKindForRequesterPrefix(prefix);
    if (kindFromPrefix) {
      inferredKind ??= kindFromPrefix;
    }
    allowBareIdKindOverride ||= prefix === channelPrefix || prefix === "room:";
    value = value.slice(prefix.length).trim();
  }
  const bareIdKind = value ? inferPeerKindFromBareId(value) : undefined;
  if (bareIdKind && (!inferredKind || allowBareIdKindOverride)) {
    // Id-embedded kind markers (Matrix `!`/`@`, IRC `#`) are more specific
    // than transport wrapper text such as Matrix `room:@user`, which is a
    // direct peer. Explicit kind prefixes like `channel:` still win.
    inferredKind = bareIdKind;
  }
  return { peerId: value || undefined, peerKind: inferredKind };
}

export function resolveRequesterOriginForChild(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterAgentId: string;
  requesterChannel?: string;
  requesterAccountId?: string;
  requesterTo?: string;
  requesterThreadId?: string | number;
  requesterGroupSpace?: string | null;
  requesterMemberRoleIds?: string[];
}) {
  const { peerId: normalizedPeerId, peerKind: inferredPeerKind } = extractRequesterPeer(
    params.requesterChannel,
    params.requesterTo,
  );
  const rawPeerIdAlias = params.requesterTo?.trim();
  // Same-agent spawns must keep the caller's active inbound account, not
  // re-resolve via bindings that may select a different account for the same
  // agent/channel.
  const boundAccountId =
    params.requesterChannel && params.targetAgentId !== params.requesterAgentId
      ? resolveFirstBoundAccountId({
          cfg: params.cfg,
          channelId: params.requesterChannel,
          agentId: params.targetAgentId,
          peerId: normalizedPeerId,
          exactPeerIdAliases:
            rawPeerIdAlias && rawPeerIdAlias !== normalizedPeerId ? [rawPeerIdAlias] : undefined,
          peerKind: inferredPeerKind,
          groupSpace: params.requesterGroupSpace,
          memberRoleIds: params.requesterMemberRoleIds,
        })
      : undefined;
  return normalizeDeliveryContext({
    channel: params.requesterChannel,
    accountId: boundAccountId ?? params.requesterAccountId,
    to: params.requesterTo,
    threadId: params.requesterThreadId,
  });
}

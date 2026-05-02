import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";

function stripZalouserTargetPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/^(zalouser|zlu):/i, "")
    .trim();
}

export function normalizeZalouserTarget(raw: string): string | undefined {
  const trimmed = stripZalouserTargetPrefix(raw);
  if (!trimmed) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:")) {
    const id = trimmed.slice("group:".length).trim();
    return id ? `group:${id}` : undefined;
  }
  if (lower.startsWith("g:")) {
    const id = trimmed.slice("g:".length).trim();
    return id ? `group:${id}` : undefined;
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (lower.startsWith("dm:")) {
    const id = trimmed.slice("dm:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (lower.startsWith("u:")) {
    const id = trimmed.slice("u:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (/^g-\S+$/i.test(trimmed)) {
    return `group:${trimmed}`;
  }
  if (/^u-\S+$/i.test(trimmed)) {
    return `user:${trimmed}`;
  }

  return trimmed;
}

export function parseZalouserOutboundTarget(raw: string): {
  threadId: string;
  isGroup: boolean;
} {
  const normalized = normalizeZalouserTarget(raw);
  if (!normalized) {
    throw new Error("Zalouser target is required");
  }
  const lowered = normalizeLowercaseStringOrEmpty(normalized);
  if (lowered.startsWith("group:")) {
    const threadId = normalized.slice("group:".length).trim();
    if (!threadId) {
      throw new Error("Zalouser group target is missing group id");
    }
    return { threadId, isGroup: true };
  }
  if (lowered.startsWith("user:")) {
    const threadId = normalized.slice("user:".length).trim();
    if (!threadId) {
      throw new Error("Zalouser user target is missing user id");
    }
    return { threadId, isGroup: false };
  }
  // Backward-compatible fallback for bare IDs.
  // Group sends should use explicit `group:<id>` targets.
  return { threadId: normalized, isGroup: false };
}

export function parseZalouserDirectoryGroupId(raw: string): string {
  const normalized = normalizeZalouserTarget(raw);
  if (!normalized) {
    throw new Error("Zalouser group target is required");
  }
  const lowered = normalizeLowercaseStringOrEmpty(normalized);
  if (lowered.startsWith("group:")) {
    const groupId = normalized.slice("group:".length).trim();
    if (!groupId) {
      throw new Error("Zalouser group target is missing group id");
    }
    return groupId;
  }
  if (lowered.startsWith("user:")) {
    throw new Error("Zalouser group members lookup requires a group target (group:<id>)");
  }
  return normalized;
}

export function resolveZalouserOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const normalized = normalizeZalouserTarget(params.target);
  if (!normalized) {
    return null;
  }
  const isGroup = (normalizeOptionalLowercaseString(normalized) ?? "").startsWith("group:");
  const peerId = normalized.replace(/^(group|user):/i, "").trim();
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "zalouser",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `zalouser:group:${peerId}` : `zalouser:${peerId}`,
    to: `zalouser:${peerId}`,
  });
}

import { buildChannelOutboundSessionRoute } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Googlechat plugin module implements targets behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleChatAccount, type ResolvedGoogleChatAccount } from "./accounts.js";
import { findGoogleChatDirectMessage, getGoogleChatSpace } from "./api.js";
import type { GoogleChatSpace } from "./types.js";

export function normalizeGoogleChatTarget(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutPrefix = trimmed.replace(/^(googlechat|google-chat|gchat):/i, "");
  const normalized = withoutPrefix
    .replace(/^user:(users\/)?/i, "users/")
    .replace(/^space:(spaces\/)?/i, "spaces/");
  if (isGoogleChatUserTarget(normalized)) {
    const suffix = normalized.slice("users/".length);
    return suffix.includes("@") ? `users/${normalizeLowercaseStringOrEmpty(suffix)}` : normalized;
  }
  if (isGoogleChatSpaceTarget(normalized)) {
    return normalized;
  }
  if (normalized.includes("@")) {
    return `users/${normalizeLowercaseStringOrEmpty(normalized)}`;
  }
  return normalized;
}

export function isGoogleChatUserTarget(value: string): boolean {
  return normalizeLowercaseStringOrEmpty(value).startsWith("users/");
}

export function isGoogleChatSpaceTarget(value: string): boolean {
  return normalizeLowercaseStringOrEmpty(value).startsWith("spaces/");
}

function resolveGoogleChatSpaceChatType(space: GoogleChatSpace): "direct" | "group" | undefined {
  const spaceType = (space.spaceType ?? "").toUpperCase();
  // The current field wins when both current and deprecated fields are present.
  if (spaceType === "DIRECT_MESSAGE") {
    return "direct";
  }
  if (spaceType === "SPACE" || spaceType === "GROUP_CHAT") {
    return "group";
  }
  if (space.singleUserBotDm === true || (space.type ?? "").toUpperCase() === "DM") {
    return "direct";
  }
  if ((space.type ?? "").toUpperCase() === "ROOM") {
    return "group";
  }
  return undefined;
}

export function isGoogleChatGroupSpace(space: GoogleChatSpace): boolean {
  // Legacy webhook payloads can omit type metadata. Preserve their historical
  // group default while outbound routing requires an exact API classification.
  return resolveGoogleChatSpaceChatType(space) !== "direct";
}

function stripMessageSuffix(target: string): string {
  const index = target.indexOf("/messages/");
  if (index === -1) {
    return target;
  }
  return target.slice(0, index);
}

export async function resolveGoogleChatOutboundSpace(params: {
  account: ResolvedGoogleChatAccount;
  target: string;
}): Promise<string> {
  const normalized = normalizeGoogleChatTarget(params.target);
  if (!normalized) {
    throw new Error("Missing Google Chat target.");
  }
  const base = stripMessageSuffix(normalized);
  if (isGoogleChatSpaceTarget(base)) {
    return base;
  }
  if (isGoogleChatUserTarget(base)) {
    const dm = await findGoogleChatDirectMessage({
      account: params.account,
      userName: base,
    });
    if (!dm?.name) {
      throw new Error(`No Google Chat DM found for ${base}`);
    }
    return dm.name;
  }
  return base;
}

export async function resolveGoogleChatOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const account = resolveGoogleChatAccount({ cfg: params.cfg, accountId: params.accountId });
  const spaceName = await resolveGoogleChatOutboundSpace({ account, target: params.target });
  if (!isGoogleChatSpaceTarget(spaceName)) {
    return null;
  }
  let space: GoogleChatSpace;
  try {
    space = await getGoogleChatSpace({ account, spaceName });
  } catch {
    // Space classification only enriches session routing. Delivery must remain
    // available when this auxiliary read is unavailable or lacks permission.
    return null;
  }
  const chatType = resolveGoogleChatSpaceChatType(space);
  if (!chatType) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "googlechat",
    accountId: params.accountId,
    recipientSessionExact: true,
    peer: { kind: chatType, id: spaceName },
    chatType,
    from: `googlechat:${spaceName}`,
    to: spaceName,
  });
}

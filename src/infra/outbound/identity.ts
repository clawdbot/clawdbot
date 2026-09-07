// Outbound identity helpers project configured agent identity/avatar metadata
// into channel-safe send payload fields.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentAvatar } from "../../agents/identity-avatar.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundIdentity } from "./identity-types.js";

export type { OutboundIdentity } from "./identity-types.js";

/** Trims outbound identity fields and drops empty identity payloads. */
export function normalizeOutboundIdentity(
  identity?: OutboundIdentity | null,
): OutboundIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const name = normalizeOptionalString(identity.name);
  const avatarUrl = normalizeOptionalString(identity.avatarUrl);
  const emoji = normalizeOptionalString(identity.emoji);
  const theme = normalizeOptionalString(identity.theme);
  if (!name && !avatarUrl && !emoji && !theme) {
    return undefined;
  }
  return { name, avatarUrl, emoji, theme };
}

/** Resolves an agent's configured identity into channel-safe outbound metadata. */
export function resolveAgentOutboundIdentity(
  cfg: OpenClawConfig,
  agentId: string,
): OutboundIdentity | undefined {
  const agentIdentity = resolveAgentIdentity(cfg, agentId);
  const avatar = resolveAgentAvatar(cfg, agentId);
  return normalizeOutboundIdentity({
    name: agentIdentity?.name,
    emoji: agentIdentity?.emoji,
    avatarUrl: avatar.kind === "remote" ? avatar.url : undefined,
    theme: agentIdentity?.theme,
  });
}

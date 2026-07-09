// Gateway assistant identity resolver.
// Combines UI, agent config, and workspace identity files for Control UI display.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { loadAgentIdentity } from "../commands/agents.config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  isAvatarHttpUrl,
  isAvatarImageDataUrl,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";

const ASSISTANT_IDENTITY_LIMITS = {
  name: 50,
  // Image-bearing avatars must round-trip without truncation. This matches
  // MAX_LOCAL_USER_IMAGE_AVATAR / AVATAR_MAX_BYTES expansion.
  avatar: 2_000_000,
  emoji: 16,
} as const;
type AssistantIdentityField = keyof typeof ASSISTANT_IDENTITY_LIMITS;

export const DEFAULT_ASSISTANT_IDENTITY: AssistantIdentity = {
  agentId: "main",
  name: "Assistant",
  avatar: "A",
};

type AssistantIdentity = {
  agentId: string;
  name: string;
  avatar: string;
  emoji?: string;
};

function normalizeIdentityValue(
  field: AssistantIdentityField,
  value: string | undefined,
): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? truncateUtf16Safe(trimmed, ASSISTANT_IDENTITY_LIMITS[field]) : undefined;
}

function isAvatarUrl(value: string): boolean {
  return isAvatarHttpUrl(value) || isAvatarImageDataUrl(value);
}

// Candidates are already trimmed and field-bounded by normalizeIdentityValue.
function normalizeAvatarValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (isAvatarUrl(value)) {
    return value;
  }
  if (looksLikeAvatarPath(value)) {
    return value;
  }
  if (!/\s/.test(value) && value.length <= 4) {
    return value;
  }
  return undefined;
}

function normalizeEmojiValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  let hasNonAscii = false;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) {
    return undefined;
  }
  if (isAvatarUrl(value) || looksLikeAvatarPath(value)) {
    return undefined;
  }
  return value;
}

/** Resolve the display name/avatar/emoji for an agent-facing assistant identity. */
export function resolveAssistantIdentity(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  workspaceDir?: string | null;
}): AssistantIdentity {
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const agentId = normalizeAgentId(params.agentId ?? defaultAgentId);
  const isDefaultAgent = agentId === defaultAgentId;
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const configAssistant = params.cfg.ui?.assistant;
  const agentIdentity = resolveAgentIdentity(params.cfg, agentId);
  const fileIdentity = workspaceDir ? loadAgentIdentity(workspaceDir) : null;

  const uiName = normalizeIdentityValue("name", configAssistant?.name);
  const agentName = normalizeIdentityValue("name", agentIdentity?.name);
  const fileName = normalizeIdentityValue("name", fileIdentity?.name);
  const name =
    (isDefaultAgent ? (uiName ?? agentName ?? fileName) : (agentName ?? fileName ?? uiName)) ??
    DEFAULT_ASSISTANT_IDENTITY.name;

  const uiAvatar = normalizeIdentityValue("avatar", configAssistant?.avatar);
  const agentAvatarCandidates = [
    normalizeIdentityValue("avatar", agentIdentity?.avatar),
    normalizeIdentityValue("avatar", agentIdentity?.emoji),
    normalizeIdentityValue("avatar", fileIdentity?.avatar),
    normalizeIdentityValue("avatar", fileIdentity?.emoji),
  ];
  const avatarCandidates = isDefaultAgent
    ? [uiAvatar, ...agentAvatarCandidates]
    : [...agentAvatarCandidates, uiAvatar];
  const avatar =
    avatarCandidates.map((candidate) => normalizeAvatarValue(candidate)).find(Boolean) ??
    DEFAULT_ASSISTANT_IDENTITY.avatar;

  const emojiCandidates = [
    normalizeIdentityValue("emoji", agentIdentity?.emoji),
    normalizeIdentityValue("emoji", fileIdentity?.emoji),
    normalizeIdentityValue("emoji", agentIdentity?.avatar),
    normalizeIdentityValue("emoji", fileIdentity?.avatar),
  ];
  const emoji = emojiCandidates.map((candidate) => normalizeEmojiValue(candidate)).find(Boolean);

  return { agentId, name, avatar, emoji };
}

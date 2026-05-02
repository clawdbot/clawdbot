import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { loadAgentIdentity } from "../commands/agents.config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { coerceIdentityValue } from "../shared/assistant-identity-values.js";
import {
  isAvatarHttpUrl,
  isAvatarImageDataUrl,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";

const MAX_ASSISTANT_NAME = 50;
// Image-bearing avatars (data: URLs, paths) need to round-trip through
// coerceIdentityValue without truncation. Sized to match
// MAX_LOCAL_USER_IMAGE_AVATAR / AVATAR_MAX_BYTES expansion.
const MAX_ASSISTANT_AVATAR = 2_000_000;
const MAX_ASSISTANT_EMOJI = 16;

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

function isAvatarUrl(value: string): boolean {
  return isAvatarHttpUrl(value) || isAvatarImageDataUrl(value);
}

function normalizeAvatarValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isAvatarUrl(trimmed)) {
    return trimmed;
  }
  if (looksLikeAvatarPath(trimmed)) {
    return trimmed;
  }
  if (!/\s/.test(trimmed) && trimmed.length <= 4) {
    return trimmed;
  }
  return undefined;
}

function normalizeEmojiValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > MAX_ASSISTANT_EMOJI) {
    return undefined;
  }
  let hasNonAscii = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) {
    return undefined;
  }
  if (isAvatarUrl(trimmed) || looksLikeAvatarPath(trimmed)) {
    return undefined;
  }
  return trimmed;
}

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

  const uiName = coerceIdentityValue(configAssistant?.name, MAX_ASSISTANT_NAME);
  const agentName = coerceIdentityValue(agentIdentity?.name, MAX_ASSISTANT_NAME);
  const fileName = coerceIdentityValue(fileIdentity?.name, MAX_ASSISTANT_NAME);
  const name =
    (isDefaultAgent ? (uiName ?? agentName ?? fileName) : (agentName ?? fileName ?? uiName)) ??
    DEFAULT_ASSISTANT_IDENTITY.name;

  const uiAvatar = coerceIdentityValue(configAssistant?.avatar, MAX_ASSISTANT_AVATAR);
  const agentAvatarCandidates = [
    coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_AVATAR),
  ];
  const avatarCandidates = isDefaultAgent
    ? [uiAvatar, ...agentAvatarCandidates]
    : [...agentAvatarCandidates, uiAvatar];
  const avatar =
    avatarCandidates.map((candidate) => normalizeAvatarValue(candidate)).find(Boolean) ??
    DEFAULT_ASSISTANT_IDENTITY.avatar;

  const emojiCandidates = [
    coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_EMOJI),
    coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_EMOJI),
    coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_EMOJI),
    coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_EMOJI),
  ];
  const emoji = emojiCandidates.map((candidate) => normalizeEmojiValue(candidate)).find(Boolean);

  return { agentId, name, avatar, emoji };
}

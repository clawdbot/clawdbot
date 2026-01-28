import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { loadAgentIdentity } from "../commands/agents.config.js";
import type { MoltbotConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";

const MAX_ASSISTANT_NAME = 50;
const MAX_ASSISTANT_AVATAR = 200;

export const DEFAULT_ASSISTANT_IDENTITY: AssistantIdentity = {
  agentId: "main",
  name: "Assistant",
  avatar: "A",
};

export type AssistantIdentity = {
  agentId: string;
  name: string;
  avatar: string;
};

function coerceIdentityValue(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}

function isAvatarUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^data:image\//i.test(value);
}

function looksLikeAvatarPath(value: string): boolean {
  if (/[\\/]/.test(value)) return true;
  return /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(value);
}

function normalizeAvatarValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (isAvatarUrl(trimmed)) return trimmed;
  if (looksLikeAvatarPath(trimmed)) return trimmed;
  if (!/\s/.test(trimmed) && trimmed.length <= 4) return trimmed;
  return undefined;
}

export function resolveAssistantIdentity(params: {
  cfg: MoltbotConfig;
  agentId?: string | null;
  workspaceDir?: string | null;
}): AssistantIdentity {
  const agentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(params.cfg));
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const configAssistant = params.cfg.ui?.assistant;
  const agentIdentity = resolveAgentIdentity(params.cfg, agentId);
  const fileIdentity = workspaceDir ? loadAgentIdentity(workspaceDir) : null;

  const name =
    coerceIdentityValue(configAssistant?.name, MAX_ASSISTANT_NAME) ??
    coerceIdentityValue(agentIdentity?.name, MAX_ASSISTANT_NAME) ??
    coerceIdentityValue(fileIdentity?.name, MAX_ASSISTANT_NAME) ??
    DEFAULT_ASSISTANT_IDENTITY.name;

  const avatarCandidates = [
    coerceIdentityValue(configAssistant?.avatar, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_AVATAR),
  ];
  const avatar =
    avatarCandidates.map((candidate) => normalizeAvatarValue(candidate)).find(Boolean) ??
    DEFAULT_ASSISTANT_IDENTITY.avatar;

  return { agentId, name, avatar };
}

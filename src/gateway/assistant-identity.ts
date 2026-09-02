// Gateway assistant identity resolver.
// Combines agent config and workspace identity files for Control UI display.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { loadAgentIdentity } from "../commands/agents.config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  AVATAR_MAX_DATA_URL_CHARS,
  isRenderableAvatarImageDataUrl,
} from "../shared/avatar-limits.js";
import {
  hasAvatarUriScheme,
  isAvatarHttpUrl,
  isWindowsAbsolutePath,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";

const ASSISTANT_IDENTITY_LIMITS = {
  name: 50,
  emoji: 16,
} as const;
type AssistantIdentityField = keyof typeof ASSISTANT_IDENTITY_LIMITS;

type AssistantIdentity = {
  name: string;
  avatar: string;
  emoji?: string;
};

type AssistantIdentityNameSource = "agent" | "workspace" | "default";
type ResolvedAssistantIdentity = AssistantIdentity & {
  agentId: string;
  nameSource: AssistantIdentityNameSource;
};

export const DEFAULT_ASSISTANT_IDENTITY: AssistantIdentity = {
  name: "Assistant",
  avatar: "A",
};

function normalizeIdentityValue(
  field: AssistantIdentityField,
  value: string | undefined,
): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? truncateUtf16Safe(trimmed, ASSISTANT_IDENTITY_LIMITS[field]) : undefined;
}

function isAvatarUrl(value: string): boolean {
  return isAvatarHttpUrl(value) || isRenderableAvatarImageDataUrl(value);
}

function normalizeAvatarValue(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || trimmed.length > AVATAR_MAX_DATA_URL_CHARS) {
    return undefined;
  }
  if (isAvatarUrl(trimmed)) {
    return trimmed;
  }
  // URI-like values are not local paths. Reject unsupported schemes before
  // the slash heuristic so a bad high-priority value cannot shadow a fallback.
  if (hasAvatarUriScheme(trimmed) && !isWindowsAbsolutePath(trimmed)) {
    return undefined;
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
  if (
    isAvatarUrl(value) ||
    (hasAvatarUriScheme(value) && !isWindowsAbsolutePath(value)) ||
    looksLikeAvatarPath(value)
  ) {
    return undefined;
  }
  return value;
}

// Presentation may choose the first roster entry even when ambient work needs an explicit owner.
export function resolveAssistantAgentId(cfg: OpenClawConfig, agentId?: string | null): string {
  return normalizeAgentId(
    agentId ?? tryResolveLegacyCompatibilityAgentId(cfg) ?? listAgentEntries(cfg)[0]?.id ?? "main",
  );
}

/** Resolve the display name/avatar/emoji for an agent-facing assistant identity. */
export function resolveAssistantIdentity(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  workspaceDir?: string | null;
}): ResolvedAssistantIdentity {
  const agentId = resolveAssistantAgentId(params.cfg, params.agentId);
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const agentIdentity = resolveAgentIdentity(params.cfg, agentId);
  const fileIdentity = workspaceDir ? loadAgentIdentity(workspaceDir) : null;

  const agentName = normalizeIdentityValue("name", agentIdentity?.name);
  const fileName = normalizeIdentityValue("name", fileIdentity?.name);
  const resolvedName: [string, AssistantIdentityNameSource] | undefined = agentName
    ? [agentName, "agent"]
    : fileName
      ? [fileName, "workspace"]
      : undefined;
  const [name, nameSource] = resolvedName ?? [DEFAULT_ASSISTANT_IDENTITY.name, "default"];

  const avatarCandidates = [
    normalizeAvatarValue(agentIdentity?.avatar),
    normalizeAvatarValue(agentIdentity?.emoji),
    normalizeAvatarValue(fileIdentity?.avatar),
    normalizeAvatarValue(fileIdentity?.emoji),
  ];
  const avatar = avatarCandidates.find(Boolean) ?? DEFAULT_ASSISTANT_IDENTITY.avatar;

  const emojiCandidates = [
    normalizeIdentityValue("emoji", agentIdentity?.emoji),
    normalizeIdentityValue("emoji", fileIdentity?.emoji),
    normalizeIdentityValue("emoji", agentIdentity?.avatar),
    normalizeIdentityValue("emoji", fileIdentity?.avatar),
  ];
  const emoji = emojiCandidates.map((candidate) => normalizeEmojiValue(candidate)).find(Boolean);

  return { agentId, name, nameSource, avatar, emoji };
}

import type { GatewayBrowserClient } from "../api/gateway.ts";
import { normalizeAssistantIdentity, type AssistantIdentity } from "../lib/assistant-identity.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

const LOCAL_ASSISTANT_IDENTITY_KEY = "openclaw.control.assistant.v1";

type LocalAssistantIdentity = { avatar: string | null; agentId?: string | null };

type PersistedLocalAssistantIdentities = {
  avatars?: Record<string, unknown>;
  avatar?: unknown;
  agentId?: unknown;
};

function parseLocalAssistantAvatarMap(raw: string): {
  avatars: Record<string, string>;
  legacyAvatar: string | null;
} {
  const parsed = JSON.parse(raw) as PersistedLocalAssistantIdentities;
  const avatars = Object.create(null) as Record<string, string>;
  if (parsed.avatars && typeof parsed.avatars === "object" && !Array.isArray(parsed.avatars)) {
    for (const [agentId, avatar] of Object.entries(parsed.avatars)) {
      const normalizedAgentId = normalizeOptionalString(agentId);
      const normalizedAvatar = normalizeOptionalString(avatar);
      if (normalizedAgentId && normalizedAvatar) {
        avatars[normalizedAgentId] = normalizedAvatar;
      }
    }
  }
  const legacyAvatar = normalizeOptionalString(parsed.avatar);
  const legacyAgentId = normalizeOptionalString(parsed.agentId);
  if (legacyAvatar && legacyAgentId && !Object.hasOwn(avatars, legacyAgentId)) {
    avatars[legacyAgentId] = legacyAvatar;
  }
  return { avatars, legacyAvatar: legacyAgentId ? null : (legacyAvatar ?? null) };
}

function persistLocalAssistantAvatarMap(storage: Storage | null, avatars: Record<string, string>) {
  if (Object.keys(avatars).length === 0) {
    storage?.removeItem(LOCAL_ASSISTANT_IDENTITY_KEY);
    return;
  }
  storage?.setItem(LOCAL_ASSISTANT_IDENTITY_KEY, JSON.stringify({ avatars }));
}

export function loadLocalAssistantIdentity(opts?: {
  agentId?: string | null;
}): LocalAssistantIdentity {
  const agentId = normalizeOptionalString(opts?.agentId);
  if (!agentId) {
    return { avatar: null };
  }
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(LOCAL_ASSISTANT_IDENTITY_KEY);
    if (!raw) {
      return { avatar: null };
    }
    const { avatars, legacyAvatar } = parseLocalAssistantAvatarMap(raw);
    if (!Object.hasOwn(avatars, agentId) && legacyAvatar) {
      // Assign the old global override to the first concrete agent that loads it.
      avatars[agentId] = legacyAvatar;
      persistLocalAssistantAvatarMap(storage, avatars);
    }
    return { avatar: Object.hasOwn(avatars, agentId) ? (avatars[agentId] ?? null) : null, agentId };
  } catch {
    return { avatar: null };
  }
}

export async function fetchAssistantIdentity(
  client: GatewayBrowserClient,
  sessionKey?: string,
): Promise<AssistantIdentity | null> {
  const result = await client.request<Partial<AssistantIdentity>>(
    "agent.identity.get",
    sessionKey?.trim() ? { sessionKey: sessionKey.trim() } : {},
  );
  if (!result) {
    return null;
  }
  const identity = normalizeAssistantIdentity(result);
  const localAvatar = loadLocalAssistantIdentity({ agentId: identity.agentId }).avatar;
  return localAvatar
    ? {
        ...identity,
        avatar: localAvatar,
        avatarSource: localAvatar,
        avatarStatus: "data",
        avatarReason: null,
      }
    : identity;
}

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { normalizeAssistantIdentity, type AssistantIdentity } from "../lib/assistant-identity.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

const LOCAL_ASSISTANT_IDENTITY_KEY = "openclaw.control.assistant.v1";

type LocalAssistantIdentity = { avatar: string | null; agentId?: string | null };

type PersistedLocalAssistantIdentities = {
  avatars?: Record<string, unknown>;
  avatar?: unknown;
  agentId?: unknown;
};

type AssistantIdentityCacheEntry =
  | { kind: "result"; result: AssistantIdentity | null; cachedAt: number }
  | { kind: "pending"; pending: Promise<AssistantIdentity | null> };

const ASSISTANT_IDENTITY_CACHE_TTL_MS = 60_000;
const assistantIdentityCache = new WeakMap<
  GatewayBrowserClient,
  Map<string, AssistantIdentityCacheEntry>
>();

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

export function invalidateAssistantIdentityCache(client: GatewayBrowserClient | null): void {
  if (client) {
    assistantIdentityCache.delete(client);
  }
}

export function fetchAssistantIdentity(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<AssistantIdentity | null> {
  let cache = assistantIdentityCache.get(client);
  if (!cache) {
    cache = new Map();
    assistantIdentityCache.set(client, cache);
  }
  const key = agentId.trim();
  const cached = cache.get(key);
  if (cached?.kind === "result" && Date.now() - cached.cachedAt < ASSISTANT_IDENTITY_CACHE_TTL_MS) {
    return Promise.resolve(cached.result);
  }
  if (cached?.kind === "result") {
    cache.delete(key);
  }
  if (cached?.kind === "pending") {
    return cached.pending;
  }
  const pending = client
    .request<Partial<AssistantIdentity> | null>("agent.identity.get", { agentId: key })
    .then((result) => {
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
            avatarStatus: "data" as const,
            avatarReason: null,
          }
        : identity;
    })
    .then(
      (result) => {
        const current = cache.get(key);
        if (current?.kind === "pending" && current.pending === pending) {
          cache.set(key, { kind: "result", result, cachedAt: Date.now() });
        }
        return result;
      },
      (error: unknown) => {
        const current = cache.get(key);
        if (current?.kind === "pending" && current.pending === pending) {
          cache.delete(key);
        }
        throw error;
      },
    );
  cache.set(key, { kind: "pending", pending });
  return pending;
}

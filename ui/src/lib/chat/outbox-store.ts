import { getSafeSessionStorage } from "../../local-storage.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiKnownSelectedGlobalAgentId,
} from "../sessions/session-key.ts";

const LEGACY_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v1:";
const STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v2:";
export const UNRESOLVED_GLOBAL_AGENT_SCOPE = "@unresolved";
const storedChatOutboxChangeListeners = new Set<() => void>();
let storageChangeListenerInstalled = false;

export type ChatComposerScope = {
  settings?: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
};

export type StoredComposerMainAlias = {
  key: string;
  agentId: string;
};

export type ComposerStorageTarget = {
  key: string;
  legacyKey: string;
  gatewayOwner: string;
  legacyOwnerIsUnambiguous: boolean;
};

export type ComposerStorageScope = {
  conversationKey: string;
  agentScope: string;
  routingAgentId?: string;
  isGlobal: boolean;
};

export type StoredChatOutboxScope = {
  sessionKey: string;
  agentId?: string;
};

type StoredChatOutboxSummary = {
  countsByScope: ReadonlyMap<string, number>;
  total: number;
};

const storedMainAliasByStorage = new WeakMap<
  Storage,
  Map<string, StoredComposerMainAlias | null>
>();

export function subscribeStoredChatOutboxChanges(listener: () => void): () => void {
  storedChatOutboxChangeListeners.add(listener);
  if (!storageChangeListenerInstalled && typeof window !== "undefined") {
    storageChangeListenerInstalled = true;
    window.addEventListener("storage", handleStoredChatOutboxStorageChange);
  }
  return () => {
    storedChatOutboxChangeListeners.delete(listener);
    if (
      storageChangeListenerInstalled &&
      storedChatOutboxChangeListeners.size === 0 &&
      typeof window !== "undefined"
    ) {
      storageChangeListenerInstalled = false;
      window.removeEventListener("storage", handleStoredChatOutboxStorageChange);
    }
  };
}

export function notifyStoredChatOutboxChanges(): void {
  for (const listener of storedChatOutboxChangeListeners) {
    try {
      listener();
    } catch (error) {
      console.error("[openclaw] stored chat outbox listener failed", error);
    }
  }
}

function handleStoredChatOutboxStorageChange(event: StorageEvent): void {
  if (
    event.key?.startsWith(STORAGE_KEY_PREFIX) ||
    event.key?.startsWith(LEGACY_STORAGE_KEY_PREFIX)
  ) {
    notifyStoredChatOutboxChanges();
  }
}

export function storageTargetForGateway(
  gatewayUrl: string | null | undefined,
): ComposerStorageTarget {
  const gatewayOwner = gatewayUrl?.trim() || "default";
  const encodedOwner = encodeURIComponent(gatewayOwner);
  return {
    key: `${STORAGE_KEY_PREFIX}${encodedOwner}`,
    legacyKey: `${LEGACY_STORAGE_KEY_PREFIX}${encodedOwner.slice(0, 240)}`,
    gatewayOwner,
    // Shipped v1 keys omitted the owner and truncated its encoded value. A
    // truncated row cannot prove which same-prefix gateway owns its outbox.
    legacyOwnerIsUnambiguous: encodedOwner.length < 240,
  };
}

function hasKnownSessionDefaults(state: ChatComposerScope): boolean {
  if (state.agentsList != null) {
    return true;
  }
  const snapshot = state.hello?.snapshot;
  return Boolean(
    snapshot &&
    typeof snapshot === "object" &&
    "sessionDefaults" in snapshot &&
    snapshot.sessionDefaults &&
    typeof snapshot.sessionDefaults === "object",
  );
}

export function rememberStoredMainAlias(
  storage: Storage,
  storageKey: string,
  mainAlias: StoredComposerMainAlias | undefined,
) {
  let byStorageKey = storedMainAliasByStorage.get(storage);
  if (!byStorageKey) {
    byStorageKey = new Map();
    storedMainAliasByStorage.set(storage, byStorageKey);
  }
  byStorageKey.set(storageKey, mainAlias ?? null);
}

function rememberedStoredMainAlias(
  storage: Storage,
  storageKey: string,
): StoredComposerMainAlias | undefined {
  return storedMainAliasByStorage.get(storage)?.get(storageKey) ?? undefined;
}

export function resolveComposerStorageScope(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
  storedMainAlias?: StoredComposerMainAlias,
): ComposerStorageScope {
  const parsed = parseAgentSessionKey(sessionKey);
  const normalizedSessionKey = sessionKey.trim().toLowerCase();
  const knownSessionDefaults = hasKnownSessionDefaults(state);
  const configuredMainKey = resolveUiConfiguredMainKey(state);
  const bareGlobalAlias =
    normalizedSessionKey === DEFAULT_MAIN_KEY || normalizedSessionKey === configuredMainKey;
  const storedAliasCandidate = parsed?.rest ?? normalizedSessionKey;
  const storedMainAliasMatches =
    !knownSessionDefaults && storedMainAlias?.key === storedAliasCandidate;
  const storedBareMainAliasAgentId =
    !knownSessionDefaults &&
    !parsed &&
    storedMainAlias &&
    (normalizedSessionKey === DEFAULT_MAIN_KEY || storedMainAliasMatches)
      ? storedMainAlias.agentId
      : undefined;
  const unresolvedBareMain =
    !knownSessionDefaults && !parsed && normalizedSessionKey === DEFAULT_MAIN_KEY;
  const parsedGlobalAlias =
    parsed &&
    (parsed.rest === "global" ||
      parsed.rest === DEFAULT_MAIN_KEY ||
      parsed.rest === configuredMainKey);
  const isGlobal =
    normalizedSessionKey === "global" ||
    bareGlobalAlias ||
    Boolean(parsedGlobalAlias) ||
    storedMainAliasMatches;
  const explicitAgentId = parsed?.agentId ?? agentIdOverride?.trim();
  const knownAgentId = resolveUiKnownSelectedGlobalAgentId(state);
  const bareGlobalAgentId =
    knownSessionDefaults && !parsed && bareGlobalAlias ? resolveUiDefaultAgentId(state) : undefined;
  const routingAgentId = isGlobal
    ? explicitAgentId
      ? normalizeAgentId(explicitAgentId)
      : bareGlobalAgentId
        ? bareGlobalAgentId
        : storedBareMainAliasAgentId
          ? storedBareMainAliasAgentId
          : unresolvedBareMain
            ? undefined
            : knownAgentId
              ? knownAgentId
              : storedMainAliasMatches
                ? storedMainAlias.agentId
                : undefined
    : parsed?.agentId
      ? normalizeAgentId(parsed.agentId)
      : undefined;
  const agentScope =
    routingAgentId ?? (isGlobal ? UNRESOLVED_GLOBAL_AGENT_SCOPE : DEFAULT_AGENT_ID);
  // Before Gateway defaults load, bare `main` means the unknown default agent
  // while raw `global` means the unknown selected agent. Keep their durable
  // rows distinct until those two owners can be resolved.
  const preserveBareMainRoute = unresolvedBareMain && !routingAgentId;
  return {
    conversationKey: preserveBareMainRoute ? DEFAULT_MAIN_KEY : isGlobal ? "global" : sessionKey,
    agentScope,
    ...(routingAgentId ? { routingAgentId } : {}),
    isGlobal,
  };
}

function storageSessionKeyForAgentScope(sessionKey: string, agentScope: string): string {
  return `${sessionKey}\u0000agent:${agentScope}`;
}

export function resolveStoredChatOutboxScope(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): StoredChatOutboxScope {
  const storage = getSafeSessionStorage();
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const storedMainAlias = storage ? rememberedStoredMainAlias(storage, target.key) : undefined;
  const scope = resolveComposerStorageScope(state, sessionKey, agentIdOverride, storedMainAlias);
  return {
    sessionKey: scope.conversationKey,
    ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
  };
}

export function storedChatOutboxScopeKey(scope: StoredChatOutboxScope): string {
  const normalizedSessionKey = scope.sessionKey.trim().toLowerCase();
  const agentScope =
    scope.agentId ??
    (normalizedSessionKey === "global" || normalizedSessionKey === DEFAULT_MAIN_KEY
      ? UNRESOLVED_GLOBAL_AGENT_SCOPE
      : DEFAULT_AGENT_ID);
  return storageSessionKeyForAgentScope(scope.sessionKey, agentScope);
}

type StoredChatOutboxSummaryState = {
  version?: 1 | 2;
  gatewayOwner?: string;
  mainAlias?: StoredComposerMainAlias;
  sessions?: Record<
    string,
    {
      queue?: Array<{ id?: string; pendingRunId?: string }>;
      removedQueueItemIds?: string[];
    }
  >;
};

const EMPTY_STORED_CHAT_OUTBOX_SUMMARY: StoredChatOutboxSummary = {
  countsByScope: new Map(),
  total: 0,
};

export function summarizeStoredChatOutboxes(state: ChatComposerScope): StoredChatOutboxSummary {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return EMPTY_STORED_CHAT_OUTBOX_SUMMARY;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const currentRaw = storage.getItem(target.key);
    const raw =
      currentRaw ?? (target.legacyOwnerIsUnambiguous ? storage.getItem(target.legacyKey) : null);
    if (!raw) {
      rememberStoredMainAlias(storage, target.key, undefined);
      return EMPTY_STORED_CHAT_OUTBOX_SUMMARY;
    }
    const parsed = JSON.parse(raw) as StoredChatOutboxSummaryState;
    if (
      !parsed.sessions ||
      (parsed.version !== 1 &&
        (parsed.version !== 2 || parsed.gatewayOwner !== target.gatewayOwner))
    ) {
      return EMPTY_STORED_CHAT_OUTBOX_SUMMARY;
    }
    let mainAlias = parsed.mainAlias;
    if (hasKnownSessionDefaults(state)) {
      const mainKey = resolveUiConfiguredMainKey(state);
      const refreshed =
        mainKey === DEFAULT_MAIN_KEY
          ? undefined
          : { key: mainKey, agentId: resolveUiDefaultAgentId(state) };
      if (mainAlias?.key !== refreshed?.key || mainAlias?.agentId !== refreshed?.agentId) {
        mainAlias = refreshed;
        try {
          const { mainAlias: _stale, ...stored } = parsed;
          storage.setItem(
            target.key,
            JSON.stringify({
              ...stored,
              version: 2,
              gatewayOwner: target.gatewayOwner,
              ...(mainAlias ? { mainAlias } : {}),
            }),
          );
          if (!currentRaw) {
            storage.removeItem(target.legacyKey);
          }
        } catch {
          // Readable queued state remains usable when alias refresh cannot persist.
        }
      }
    }
    rememberStoredMainAlias(storage, target.key, mainAlias);
    const itemIdsByScope = new Map<string, Set<string>>();
    const separator = "\u0000agent:";
    for (const [storeSessionKey, session] of Object.entries(parsed.sessions)) {
      const separatorIndex = storeSessionKey.lastIndexOf(separator);
      if (separatorIndex < 0 || !session.queue?.length) {
        continue;
      }
      const agentScope = storeSessionKey.slice(separatorIndex + separator.length);
      const rawSessionKey = storeSessionKey.slice(0, separatorIndex);
      const normalizedRawSessionKey = rawSessionKey.trim().toLowerCase();
      // A main-key row's embedded agent suffix is not authoritative: legacy rows
      // keep the writer's agent id. Resolve through session defaults (online) or
      // the persisted mainAlias (offline reload) so counts match sidebar scopes.
      const resolveToDefaultAgent = hasKnownSessionDefaults(state)
        ? normalizedRawSessionKey === DEFAULT_MAIN_KEY ||
          normalizedRawSessionKey === resolveUiConfiguredMainKey(state)
        : normalizedRawSessionKey === DEFAULT_MAIN_KEY ||
          (mainAlias !== undefined &&
            normalizedRawSessionKey === mainAlias.key.trim().toLowerCase());
      const scope = resolveStoredChatOutboxScope(
        state,
        rawSessionKey,
        resolveToDefaultAgent || agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE
          ? undefined
          : agentScope,
      );
      const scopeKey = storedChatOutboxScopeKey(scope);
      const itemIds = itemIdsByScope.get(scopeKey) ?? new Set<string>();
      for (const item of session.queue) {
        const id = item.id;
        if (id && !item.pendingRunId && !session.removedQueueItemIds?.includes(id)) {
          itemIds.add(id);
        }
      }
      if (itemIds.size) {
        itemIdsByScope.set(scopeKey, itemIds);
      }
    }
    const countsByScope = new Map<string, number>();
    let total = 0;
    for (const [scopeKey, itemIds] of itemIdsByScope) {
      countsByScope.set(scopeKey, itemIds.size);
      total += itemIds.size;
    }
    return { countsByScope, total };
  } catch {
    return EMPTY_STORED_CHAT_OUTBOX_SUMMARY;
  }
}

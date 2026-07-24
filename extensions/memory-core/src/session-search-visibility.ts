// Memory Core plugin module implements session search visibility behavior.
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { resolveSessionAgentId } from "openclaw/plugin-sdk/memory-host-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { sessionDeliveryOrigin } from "openclaw/plugin-sdk/session-store-runtime";
import {
  extractTranscriptIdentityFromSessionsMemoryHit,
  loadCombinedSessionStoreForGateway,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  resolveTranscriptStemToSessionKeys,
} from "openclaw/plugin-sdk/session-transcript-hit";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
} from "openclaw/plugin-sdk/session-visibility";
import { readQmdSessionArtifactIdentity } from "./qmd-session-artifacts.js";

function normalizeAgentIdForCompare(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}

function isGlobalSessionKeyForSharedScope(cfg: OpenClawConfig, key: string): boolean {
  return cfg.session?.scope === "global" && key.trim().toLowerCase() === "global";
}

type ConversationRecallContext = NonNullable<OpenClawPluginToolContext["conversationRecall"]>;

type SessionStore = ReturnType<typeof loadCombinedSessionStoreForGateway>["store"];

function isSameStoredTranscript(
  anchor: SessionStore[string] | undefined,
  candidate: SessionStore[string] | undefined,
): boolean {
  if (!anchor || !candidate) {
    return false;
  }
  const anchorSessionId = anchor.sessionId?.trim();
  if (anchorSessionId && candidate.sessionId?.trim() === anchorSessionId) {
    return true;
  }
  const anchorFile = anchor.sessionFile?.trim();
  const candidateFile = candidate.sessionFile?.trim();
  return Boolean(
    anchorFile && candidateFile && path.resolve(anchorFile) === path.resolve(candidateFile),
  );
}

function isPrivateConversation(params: {
  agentId: string;
  entry: SessionStore[string] | undefined;
  key: string;
}): boolean {
  if (!params.entry) {
    return false;
  }
  const key = params.key.trim().toLowerCase();
  const chatTypes = [params.entry.chatType, sessionDeliveryOrigin(params.entry)?.chatType].filter(
    (chatType): chatType is NonNullable<typeof chatType> => chatType !== undefined,
  );
  if (
    chatTypes.some((chatType) => chatType === "group" || chatType === "channel") ||
    /:active-memory:[a-f0-9]{12}$/i.test(key)
  ) {
    return false;
  }
  const prefix = `agent:${params.agentId.trim().toLowerCase()}:`;
  // Shared global sessions (session.scope="global") are one identity for every
  // sender; direct chat metadata does not make them private conversations.
  if (key === "global" || key === `${prefix}global`) {
    return false;
  }
  if (key.startsWith(`${prefix}explicit:`)) {
    // Gateway UI turns persist direct metadata before prompt hooks run. Requiring
    // it distinguishes private UI sessions from headless/model-run explicit keys.
    return chatTypes.length > 0 && chatTypes.every((chatType) => chatType === "direct");
  }
  if (
    key.includes(":group:") ||
    key.includes(":channel:") ||
    /:(?:active-memory|cron|heartbeat|hook|node|subagent)(?::|$)/.test(key)
  ) {
    return false;
  }
  if (chatTypes.length > 0) {
    return chatTypes.every((chatType) => chatType === "direct");
  }
  if (key.includes(":direct:") || key.includes(":dm:")) {
    return true;
  }
  return false;
}

function anchorAliasesArePrivate(params: {
  store: SessionStore;
  agentId: string;
  anchorSessionKey: string;
  anchorEntry: SessionStore[string] | undefined;
}): boolean {
  // The anchor/destination must satisfy the same all-alias fail-closed policy as
  // candidate sources: a direct key whose transcript identity also lives under a
  // group/channel alias would leak recalled private context into a shared surface.
  for (const [key, entry] of Object.entries(params.store)) {
    if (key === params.anchorSessionKey) {
      continue;
    }
    if (!isSameStoredTranscript(params.anchorEntry, entry)) {
      continue;
    }
    if (!isPrivateConversation({ agentId: params.agentId, entry, key })) {
      return false;
    }
  }
  return true;
}

function isTrustedRecallRequester(params: {
  anchorSessionKey: string;
  requesterSessionKey: string | undefined;
}): boolean {
  const requesterSessionKey = params.requesterSessionKey?.trim();
  if (!requesterSessionKey) {
    return false;
  }
  if (requesterSessionKey === params.anchorSessionKey) {
    return true;
  }
  if (!requesterSessionKey.startsWith(params.anchorSessionKey)) {
    return false;
  }
  const recallSuffix = requesterSessionKey.slice(params.anchorSessionKey.length);
  return /^:active-memory:[a-f0-9]{12}$/i.test(recallSuffix);
}

function filterSessionKeysByScopedAgent(params: {
  cfg: OpenClawConfig;
  keys: string[];
  scopedAgentId: string | undefined;
}): string[] {
  const scopedAgentId = normalizeAgentIdForCompare(params.scopedAgentId);
  if (!scopedAgentId) {
    return params.keys;
  }
  return params.keys.filter((key) => {
    if (isGlobalSessionKeyForSharedScope(params.cfg, key)) {
      return true;
    }
    const ownerAgentId = resolveSessionAgentId({
      sessionKey: key,
      config: params.cfg,
    });
    return normalizeAgentIdForCompare(ownerAgentId) === scopedAgentId;
  });
}

export async function filterMemorySearchHitsBySessionVisibility(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  requesterSessionKey: string | undefined;
  sandboxed: boolean;
  hits: MemorySearchResult[];
  conversationRecall?: ConversationRecallContext;
}): Promise<MemorySearchResult[]> {
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: params.cfg,
    sandboxed: params.sandboxed,
  });
  const a2aPolicy = createAgentToAgentPolicy(params.cfg);
  const requesterAgentId = params.requesterSessionKey
    ? resolveSessionAgentId({
        sessionKey: params.requesterSessionKey,
        config: params.cfg,
      })
    : undefined;
  const scopedAgentId = params.agentId?.trim() || requesterAgentId;
  const guard = params.requesterSessionKey
    ? await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: params.requesterSessionKey,
        visibility,
        a2aPolicy,
      })
    : null;

  const { store: combinedSessionStore } = loadCombinedSessionStoreForGateway(
    params.cfg,
    scopedAgentId ? { agentId: scopedAgentId } : {},
  );

  const conversationRecall = params.conversationRecall;
  const anchorSessionKey = conversationRecall?.anchorSessionKey.trim();
  const recallAgentId = anchorSessionKey
    ? resolveSessionAgentId({ sessionKey: anchorSessionKey, config: params.cfg })
    : undefined;
  const anchorEntry = anchorSessionKey ? combinedSessionStore[anchorSessionKey] : undefined;
  const recallAuthorized = Boolean(
    conversationRecall &&
    !params.sandboxed &&
    conversationRecall.scope === "same-agent-private" &&
    (conversationRecall.corpus === "sessions" || conversationRecall.corpus === "configured") &&
    anchorSessionKey &&
    isTrustedRecallRequester({
      anchorSessionKey,
      requesterSessionKey: params.requesterSessionKey,
    }) &&
    normalizeAgentIdForCompare(recallAgentId) === normalizeAgentIdForCompare(scopedAgentId) &&
    recallAgentId &&
    isPrivateConversation({
      agentId: recallAgentId,
      entry: anchorEntry,
      key: anchorSessionKey,
    }) &&
    anchorAliasesArePrivate({
      store: combinedSessionStore,
      agentId: recallAgentId,
      anchorSessionKey,
      anchorEntry,
    }),
  );
  if (conversationRecall && !recallAuthorized) {
    return conversationRecall.corpus === "configured"
      ? params.hits.filter((hit) => hit.source !== "sessions")
      : [];
  }

  const isSessionKeyAllowed = (key: string): boolean => {
    if (!conversationRecall || !anchorSessionKey || !recallAgentId) {
      return guard?.check(key).allowed === true;
    }
    const candidateEntry = combinedSessionStore[key];
    // Canonical and legacy alias keys can identify one transcript. Exclude the
    // anchor by transcript identity so an alias cannot re-inject current context.
    if (key === anchorSessionKey || isSameStoredTranscript(anchorEntry, candidateEntry)) {
      return false;
    }
    const candidateAgentId = resolveSessionAgentId({ sessionKey: key, config: params.cfg });
    if (
      normalizeAgentIdForCompare(candidateAgentId) !== normalizeAgentIdForCompare(recallAgentId)
    ) {
      return false;
    }
    return isPrivateConversation({
      agentId: recallAgentId,
      entry: candidateEntry,
      key,
    });
  };

  const expandRecallAliasKeys = (keys: string[]): string[] => {
    // Alias resolution by session id can miss a group/channel alias that shares
    // the same transcript file under a different session id. Recall must judge
    // every alias, so expand candidates by stored transcript identity.
    const expanded = new Set(keys);
    for (const key of keys) {
      const entry = combinedSessionStore[key];
      if (!entry) {
        continue;
      }
      for (const [candidateKey, candidateEntry] of Object.entries(combinedSessionStore)) {
        if (isSameStoredTranscript(entry, candidateEntry)) {
          expanded.add(candidateKey);
        }
      }
    }
    return [...expanded];
  };

  const areSessionKeysAllowed = (keys: string[]): boolean => {
    // Product recall fails closed when aliases disagree about privacy. Ordinary
    // session-tool visibility keeps its existing any-visible-alias behavior.
    return conversationRecall
      ? expandRecallAliasKeys(keys).every(isSessionKeyAllowed)
      : keys.some(isSessionKeyAllowed);
  };

  const next: MemorySearchResult[] = [];
  for (const hit of params.hits) {
    if (hit.source !== "sessions") {
      if (!conversationRecall || conversationRecall.corpus === "configured") {
        next.push(hit);
      }
      continue;
    }
    if (!params.requesterSessionKey || (!guard && !conversationRecall)) {
      continue;
    }
    const artifactIdentity = readQmdSessionArtifactIdentity(hit);
    if (artifactIdentity) {
      const normalizedScopedAgentId = normalizeAgentIdForCompare(scopedAgentId);
      const normalizedOwnerAgentId = normalizeAgentIdForCompare(artifactIdentity.agentId);
      if (
        normalizedScopedAgentId &&
        normalizedOwnerAgentId &&
        normalizedOwnerAgentId !== normalizedScopedAgentId
      ) {
        continue;
      }
      const keys = filterSessionKeysByScopedAgent({
        cfg: params.cfg,
        scopedAgentId,
        keys: resolveSessionTranscriptMemoryHitKeyToSessionKeys({
          store: combinedSessionStore,
          key: artifactIdentity.memoryKey,
          includeSyntheticFallback: artifactIdentity.archived,
        }),
      });
      if (keys.length === 0) {
        continue;
      }
      const allowed = areSessionKeysAllowed(keys);
      if (!allowed) {
        continue;
      }
      next.push(hit);
      continue;
    }
    // Deprecated migration compatibility for older QMD/session rows that were
    // indexed before memory-core stored artifact-to-transcript identity.
    const identity = extractTranscriptIdentityFromSessionsMemoryHit(hit.path);
    if (!identity) {
      continue;
    }
    const isQmdSessionHit = hit.path.replace(/\\/g, "/").startsWith("qmd/");
    const normalizedScopedAgentId = normalizeAgentIdForCompare(scopedAgentId);
    const normalizedOwnerAgentId = normalizeAgentIdForCompare(identity.ownerAgentId);
    if (
      normalizedScopedAgentId &&
      normalizedOwnerAgentId &&
      normalizedOwnerAgentId !== normalizedScopedAgentId
    ) {
      continue;
    }
    const sameAgentLiveOwnerId =
      !identity.archived &&
      normalizedScopedAgentId &&
      normalizedOwnerAgentId === normalizedScopedAgentId
        ? normalizedOwnerAgentId
        : undefined;
    const archivedOwnerMatchesScope = Boolean(
      identity.archived &&
      ((identity.ownerAgentId &&
        (!scopedAgentId ||
          normalizeAgentIdForCompare(identity.ownerAgentId) ===
            normalizeAgentIdForCompare(scopedAgentId))) ||
        (isQmdSessionHit && scopedAgentId)),
    );
    const archivedOwnerAgentId = archivedOwnerMatchesScope
      ? (identity.ownerAgentId ?? scopedAgentId)
      : undefined;
    const liveKeys = identity.liveStem
      ? resolveTranscriptStemToSessionKeys({
          store: combinedSessionStore,
          stem: identity.liveStem,
          allowQmdSlugFallback: false,
        })
      : [];
    const resolvedKeys =
      liveKeys.length > 0
        ? liveKeys
        : resolveTranscriptStemToSessionKeys({
            store: combinedSessionStore,
            stem: identity.stem,
            allowQmdSlugFallback: isQmdSessionHit && !identity.archived,
            ...(archivedOwnerAgentId ? { archivedOwnerAgentId } : {}),
          });
    const keys = filterSessionKeysByScopedAgent({
      cfg: params.cfg,
      scopedAgentId,
      keys: resolvedKeys,
    });
    if (keys.length === 0) {
      const agentWideVisibility = visibility === "agent" || visibility === "all";
      if (sameAgentLiveOwnerId && agentWideVisibility && !conversationRecall) {
        next.push(hit);
      }
      continue;
    }
    const allowed = areSessionKeysAllowed(keys);
    if (!allowed) {
      continue;
    }
    next.push(hit);
  }
  return next;
}

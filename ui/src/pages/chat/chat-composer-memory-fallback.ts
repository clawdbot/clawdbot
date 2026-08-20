import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  DEFAULT_MAIN_KEY,
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiKnownSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { releaseDisplacedChatAttachmentPayloads } from "./attachment-payload-store.ts";
import type { ChatComposerMemoryFallback, ChatPageHost } from "./chat-state-host.ts";
import {
  loadChatComposerCommittedDraftRevision,
  loadChatComposerDraftRevision,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  type ChatComposerDraftRetry,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";

let lastChatComposerMemoryFallbackSequence = 0;

export type ChatComposerMemoryFallbackOwnership = {
  sequence: number;
};

function resolveChatComposerMemoryFallback(
  state: ChatPageHost,
  sessionKey: string,
  scopeOverride?: StoredChatOutboxScope,
): { fallback?: ChatComposerMemoryFallback; scopeKey: string } {
  const scope = scopeOverride ?? resolveStoredChatOutboxScope(state, sessionKey);
  const scopeKey = storedChatOutboxScopeKey(scope);
  const fallback = state.chatComposerFallbackByScope[scopeKey];
  const selectedGlobalAgentId = resolveUiKnownSelectedGlobalAgentId(state);
  if (scope.sessionKey !== "global" || !scope.agentId) {
    return { fallback, scopeKey };
  }
  const configuredMainKey = resolveUiConfiguredMainKey(state);
  const isSelectedTarget = scope.agentId === selectedGlobalAgentId;
  const isDefaultTarget = scope.agentId === resolveUiDefaultAgentId(state);
  const qualifiedMainScopeKey =
    configuredMainKey === DEFAULT_MAIN_KEY
      ? undefined
      : storedChatOutboxScopeKey({
          sessionKey: buildAgentMainSessionKey({
            agentId: scope.agentId,
            mainKey: configuredMainKey,
          }),
          agentId: scope.agentId,
        });
  if (!isSelectedTarget && !isDefaultTarget && !qualifiedMainScopeKey) {
    return { fallback, scopeKey };
  }
  const fallbackSourceKeys = new Set([scopeKey]);
  if (isSelectedTarget) {
    fallbackSourceKeys.add(storedChatOutboxScopeKey({ sessionKey: "global" }));
  }
  if (isDefaultTarget) {
    fallbackSourceKeys.add(storedChatOutboxScopeKey({ sessionKey: DEFAULT_MAIN_KEY }));
    fallbackSourceKeys.add(storedChatOutboxScopeKey({ sessionKey: configuredMainKey }));
  }
  if (qualifiedMainScopeKey) {
    fallbackSourceKeys.add(qualifiedMainScopeKey);
  }
  const candidates = [...fallbackSourceKeys]
    .map((candidateScopeKey) => ({
      fallback: state.chatComposerFallbackByScope[candidateScopeKey],
      scopeKey: candidateScopeKey,
    }))
    .filter(
      (candidate): candidate is { fallback: ChatComposerMemoryFallback; scopeKey: string } =>
        candidate.fallback !== undefined,
    );
  const newest = candidates.toSorted(
    (left, right) => right.fallback.sequence - left.fallback.sequence,
  )[0];
  if (!newest) {
    return { scopeKey };
  }
  const sourceKey = newest.scopeKey;
  const sourceFallback = newest.fallback;
  if (candidates.length === 1 && sourceKey === scopeKey) {
    return { fallback: sourceFallback, scopeKey };
  }
  let adoptedFallback = sourceFallback;
  if (sourceKey !== scopeKey && sourceFallback.draftRetry) {
    const committedRevision = loadChatComposerCommittedDraftRevision(
      state,
      sessionKey,
      scope.agentId,
    );
    const latestRevision = loadChatComposerDraftRevision(state, sessionKey, scope.agentId);
    // Rebase only when this unresolved edit is newer than every resolved
    // attempt. Otherwise its original CAS must keep newer pane input intact.
    if (sourceFallback.draftRetry.draftRevision > latestRevision) {
      adoptedFallback = {
        ...sourceFallback,
        draftRetry: {
          ...sourceFallback.draftRetry,
          expectedDraftRevision: committedRevision,
        },
      };
    }
  }
  const nextFallbacks = { ...state.chatComposerFallbackByScope };
  for (const candidate of candidates) {
    delete nextFallbacks[candidate.scopeKey];
  }
  nextFallbacks[scopeKey] = adoptedFallback;
  // Losing sibling fallbacks are dropped for good here; release their
  // payload-store entries (like the pane-handoff owner does) or the data URLs
  // leak for the pane's lifetime.
  releaseDisplacedChatAttachmentPayloads(
    candidates.flatMap((candidate) => candidate.fallback.attachments),
    [state.chatAttachments, ...Object.values(nextFallbacks).map((f) => f.attachments)],
  );
  state.chatComposerFallbackByScope = nextFallbacks;
  return { fallback: adoptedFallback, scopeKey };
}

export function storeChatComposerMemoryFallback(
  state: ChatPageHost,
  scope: StoredChatOutboxScope,
  composer: {
    message: string;
    attachments: ChatAttachment[];
    draftRetry?: ChatComposerDraftRetry;
  },
): ChatComposerMemoryFallbackOwnership {
  const sequence = ++lastChatComposerMemoryFallbackSequence;
  state.chatComposerFallbackByScope = {
    ...state.chatComposerFallbackByScope,
    [storedChatOutboxScopeKey(scope)]: {
      message: composer.message,
      attachments: [...composer.attachments],
      storageFailed: composer.draftRetry !== undefined,
      sequence,
      ...(composer.draftRetry ? { draftRetry: composer.draftRetry } : {}),
    },
  };
  return { sequence };
}

function chatAttachmentsMatch(
  left: readonly ChatAttachment[],
  right: readonly ChatAttachment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.id === right[index]?.id)
  );
}

export function retainChatComposerMemoryFallback(
  state: ChatPageHost,
  scope: StoredChatOutboxScope,
  composer: { message: string; attachments: ChatAttachment[] },
): ChatComposerMemoryFallbackOwnership | undefined {
  const { fallback: existing, scopeKey } = resolveChatComposerMemoryFallback(
    state,
    scope.sessionKey,
    scope,
  );
  const existingMatches =
    existing?.message === composer.message &&
    chatAttachmentsMatch(existing.attachments, composer.attachments);
  if (existing && existingMatches) {
    return { sequence: existing.sequence };
  }
  if (existing?.storageFailed && !existing.message.trim() && existing.attachments.length === 0) {
    state.chatComposerFallbackByScope = {
      ...state.chatComposerFallbackByScope,
      [scopeKey]: {
        ...existing,
        message: composer.message,
        attachments: [...composer.attachments],
      },
    };
    return { sequence: existing.sequence };
  }
  if (
    existing &&
    (existing.storageFailed || existing.message.trim() || existing.attachments.length > 0)
  ) {
    return undefined;
  }
  return storeChatComposerMemoryFallback(state, scope, composer);
}

export function captureChatComposerMemoryFallbackOwnership(
  state: ChatPageHost,
  scope: StoredChatOutboxScope,
  composer: { message: string; attachments: ChatAttachment[] },
): ChatComposerMemoryFallbackOwnership | undefined {
  const { fallback: existing } = resolveChatComposerMemoryFallback(state, scope.sessionKey, scope);
  if (
    existing?.message !== composer.message ||
    !chatAttachmentsMatch(existing.attachments, composer.attachments)
  ) {
    return undefined;
  }
  return { sequence: existing.sequence };
}

export function ownsChatComposerMemoryFallback(
  state: Pick<ChatPageHost, "chatComposerFallbackByScope">,
  ownership: ChatComposerMemoryFallbackOwnership,
): boolean {
  return Object.values(state.chatComposerFallbackByScope).some(
    (fallback) => fallback.sequence === ownership.sequence,
  );
}

export function clearChatComposerMemoryFallback(
  state: Pick<ChatPageHost, "chatComposerFallbackByScope">,
  ownership: ChatComposerMemoryFallbackOwnership | undefined,
): boolean {
  if (!ownership) {
    return false;
  }
  const ownedEntries = Object.entries(state.chatComposerFallbackByScope).filter(
    ([, fallback]) => fallback.sequence === ownership.sequence,
  );
  if (ownedEntries.length === 0) {
    return false;
  }
  const nextFallbacks = { ...state.chatComposerFallbackByScope };
  for (const [scopeKey] of ownedEntries) {
    delete nextFallbacks[scopeKey];
  }
  state.chatComposerFallbackByScope = nextFallbacks;
  return true;
}

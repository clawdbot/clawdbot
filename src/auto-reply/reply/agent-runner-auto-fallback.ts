import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  hasSessionAutoModelFallbackProvenance,
  resolveAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import type { FollowupRun } from "./queue.js";

function sessionEntryMatchesSnapshot(entry: SessionEntry, snapshot: SessionEntry): boolean {
  return isDeepStrictEqual(entry, snapshot);
}

function sessionEntryOnlyUpdatedAtChanged(entry: SessionEntry, snapshot: SessionEntry): boolean {
  if (entry.updatedAt === snapshot.updatedAt) {
    return false;
  }
  const entryWithoutUpdatedAt = { ...entry, updatedAt: snapshot.updatedAt };
  return isDeepStrictEqual(entryWithoutUpdatedAt, snapshot);
}

/** Decides whether to retry after rechecking auto-fallback primary probe state. */
export function resolveRunAfterAutoFallbackPrimaryProbeRecheck(params: {
  run: FollowupRun["run"];
  entry?: SessionEntry;
  sessionKey?: string;
}): FollowupRun["run"] {
  const probe = params.run.autoFallbackPrimaryProbe;
  if (!probe || !params.sessionKey || !params.entry) {
    return params.run;
  }
  const resolveEntrySelectionRun = (): FollowupRun["run"] => {
    const entryRef = resolvePersistedOverrideModelRef({
      defaultProvider: params.run.provider,
      overrideProvider: params.entry?.providerOverride,
      overrideModel: params.entry?.modelOverride,
    });
    const hasEntryModelOverride = Boolean(entryRef);
    const authProfileId = normalizeOptionalString(params.entry?.authProfileOverride);
    const fallbackRun: FollowupRun["run"] = {
      ...params.run,
      provider: entryRef?.provider ?? params.run.provider,
      model: entryRef?.model ?? params.run.model,
      autoFallbackPrimaryProbe: undefined,
    };
    if (hasEntryModelOverride) {
      fallbackRun.hasSessionModelOverride = true;
      fallbackRun.hasAutoFallbackProvenance =
        hasSessionAutoModelFallbackProvenance(params.entry) || undefined;
    } else {
      delete fallbackRun.hasSessionModelOverride;
      delete fallbackRun.hasAutoFallbackProvenance;
    }
    if (hasEntryModelOverride && params.entry?.modelOverrideSource) {
      fallbackRun.modelOverrideSource = params.entry.modelOverrideSource;
    } else {
      delete fallbackRun.modelOverrideSource;
    }
    if (hasEntryModelOverride && authProfileId) {
      fallbackRun.authProfileId = authProfileId;
      if (params.entry?.authProfileOverrideSource) {
        fallbackRun.authProfileIdSource = params.entry.authProfileOverrideSource;
      } else {
        delete fallbackRun.authProfileIdSource;
      }
    } else if (hasEntryModelOverride) {
      delete fallbackRun.authProfileId;
      delete fallbackRun.authProfileIdSource;
    }
    return fallbackRun;
  };
  const refreshedProbe = resolveAutoFallbackPrimaryProbe({
    entry: params.entry,
    sessionKey: params.sessionKey,
    primaryProvider: probe.provider,
    primaryModel: probe.model,
  });
  if (!refreshedProbe) {
    return resolveEntrySelectionRun();
  }
  return {
    ...params.run,
    provider: refreshedProbe.provider,
    model: refreshedProbe.model,
    autoFallbackPrimaryProbe: refreshedProbe,
  };
}

/** Clears a recovered primary probe without overwriting a newer session selection. */
export async function clearRecoveredAutoFallbackPrimaryProbeSelection(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
  sessionKey?: string;
  activeSessionStore?: Record<string, SessionEntry>;
  getActiveSessionEntry: () => SessionEntry | undefined;
  storePath?: string;
}): Promise<void> {
  if (shouldPreserveUserFacingSessionStateForInputProvenance(params.run.inputProvenance)) {
    return;
  }
  const probe = params.run.autoFallbackPrimaryProbe;
  if (!probe || params.provider !== probe.provider || params.model !== probe.model) {
    return;
  }
  if (!params.sessionKey || !params.activeSessionStore) {
    return;
  }
  const cachedSessionEntry = params.activeSessionStore[params.sessionKey];
  const activeSessionEntry = cachedSessionEntry ?? params.getActiveSessionEntry();
  if (!activeSessionEntry || !entryMatchesAutoFallbackPrimaryProbe(activeSessionEntry, probe)) {
    return;
  }
  const activeSessionEntryBeforeUpdate = structuredClone(activeSessionEntry);
  if (!params.storePath) {
    clearAutoFallbackPrimaryProbeSelection(activeSessionEntry);
    params.activeSessionStore[params.sessionKey] = activeSessionEntry;
    return;
  }
  let comparedEntry: SessionEntry | undefined;
  const updatedEntry = await updateSessionEntry(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    (persistedEntry) => {
      comparedEntry = persistedEntry;
      if (
        persistedEntry.sessionId !== activeSessionEntryBeforeUpdate.sessionId ||
        persistedEntry.updatedAt !== activeSessionEntryBeforeUpdate.updatedAt ||
        !entryMatchesAutoFallbackPrimaryProbe(persistedEntry, probe)
      ) {
        return null;
      }
      const shouldClearAuthProfile =
        persistedEntry.authProfileOverrideSource === "auto" ||
        (persistedEntry.authProfileOverrideSource === undefined &&
          persistedEntry.authProfileOverrideCompactionCount !== undefined);
      clearAutoFallbackPrimaryProbeSelection(persistedEntry);
      return {
        providerOverride: undefined,
        modelOverride: undefined,
        modelOverrideSource: undefined,
        modelOverrideFallbackOriginProvider: undefined,
        modelOverrideFallbackOriginModel: undefined,
        ...(shouldClearAuthProfile
          ? {
              authProfileOverride: undefined,
              authProfileOverrideSource: undefined,
              authProfileOverrideCompactionCount: undefined,
            }
          : {}),
        fallbackNoticeSelectedModel: undefined,
        fallbackNoticeActiveModel: undefined,
        fallbackNoticeReason: undefined,
        updatedAt: persistedEntry.updatedAt,
      };
    },
  );
  // The persisted comparison owns selection freshness. Publish its updated
  // result, or refresh the cache from the entry that rejected this probe.
  const authoritativeEntry = updatedEntry ?? comparedEntry;
  const currentCachedEntry = params.activeSessionStore[params.sessionKey];
  // Object replacement is a new cache generation even when values match.
  // Preserve it to avoid clearing an identically reselected fallback.
  if (currentCachedEntry !== cachedSessionEntry) {
    return;
  }
  const currentEntry = currentCachedEntry ?? (cachedSessionEntry ? undefined : activeSessionEntry);
  if (!currentEntry) {
    return;
  }
  if (authoritativeEntry) {
    if (sessionEntryMatchesSnapshot(currentEntry, activeSessionEntryBeforeUpdate)) {
      params.activeSessionStore[params.sessionKey] = authoritativeEntry;
      return;
    }
    if (
      currentEntry.sessionId !== activeSessionEntryBeforeUpdate.sessionId ||
      sessionEntryOnlyUpdatedAtChanged(currentEntry, activeSessionEntryBeforeUpdate)
    ) {
      return;
    }
    params.activeSessionStore[params.sessionKey] = mergeSessionSnapshotChanges({
      initial: activeSessionEntryBeforeUpdate,
      next: authoritativeEntry,
      current: currentEntry,
    });
  } else if (sessionEntryMatchesSnapshot(currentEntry, activeSessionEntryBeforeUpdate)) {
    delete params.activeSessionStore[params.sessionKey];
  }
}

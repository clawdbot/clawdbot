import { resolveSessionModelOverrideRouteResolution } from "../../config/sessions/model-override-provenance.js";
/** Atomic repair for automatic-fallback overrides whose recorded origin is stale.
 *  - `clear-override`: the origin equals the fallback override itself (provably polluted), so the
 *    override is cleared and the turn retries the configured primary.
 *  - `repair-origin`: the origin differs from both the primary and the override (the canonical
 *    #92776 three-distinct state), so the origin is updated to the current primary to let the
 *    snap-back probe fire while preserving the fallback override.
 *  The write is guarded by the exact observed snapshot so a concurrent reset, user selection,
 *  or newer automatic fallback does not receive stale repair metadata. Commit-edge conflicts
 *  caused by an interleaved write adopt the newer persisted row instead of failing the turn. */
import {
  loadSessionEntryReadOnly,
  patchSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  applyModelOverrideToSessionEntry,
  isModelSelectionLocked,
} from "../../sessions/model-overrides.js";
import {
  classifyStaleAutoFallbackOriginOverride,
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionAutoModelFallbackProvenance,
  matchesStaleAutoFallbackOriginRepairSnapshot,
  type StaleAutoFallbackOriginRepairKind,
} from "../agent-scope.js";

type StaleAutoFallbackOriginRepairResult = {
  entry: SessionEntry;
  hasStoredOverride: boolean;
  storedModelOverrideSource: "auto" | "user" | undefined;
  storedModelOverrideRouteResolution: "resolved" | "raw" | undefined;
  hasStoredAutoFallbackProvenance: boolean;
  hasLegacyAutoFallbackOverrideWithoutOrigin: boolean;
};

export async function repairStaleAutoFallbackOriginOverride(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string | undefined;
  primaryProvider: string;
  primaryModel: string;
}): Promise<StaleAutoFallbackOriginRepairResult> {
  const {
    sessionEntry: observedSnapshot,
    sessionStore,
    sessionKey,
    storePath,
    primaryProvider,
    primaryModel,
  } = params;
  const repairKind = classifyStaleAutoFallbackOriginOverride(
    observedSnapshot,
    primaryProvider,
    primaryModel,
  );
  if (!repairKind) {
    return deriveRepairResult(observedSnapshot);
  }
  // Locked sessions must not have their selection mutated; the reply path and legacy repair
  // already exclude them, and applyModelOverrideToSessionEntry would throw here.
  if (isModelSelectionLocked(observedSnapshot)) {
    return deriveRepairResult(observedSnapshot);
  }
  const entry = prepareRepairedEntry({
    observedSnapshot,
    repairKind,
    primaryProvider,
    primaryModel,
  });
  if (entry === observedSnapshot) {
    return deriveRepairResult(observedSnapshot);
  }
  if (!storePath) {
    return deriveRepairResult(entry);
  }
  let comparedEntry: SessionEntry | undefined;
  try {
    const persistedEntry = await patchSessionEntry(
      { storePath, sessionKey },
      (currentEntry) => {
        comparedEntry = currentEntry;
        if (!matchesStaleAutoFallbackOriginRepairSnapshot(currentEntry, observedSnapshot)) {
          return null;
        }
        return mergeSessionSnapshotChanges({
          initial: observedSnapshot,
          next: entry,
          current: currentEntry,
        });
      },
      { fallbackEntry: sessionStore[sessionKey] ?? entry, replaceEntry: true },
    );
    // The persisted comparison owns selection freshness. Publish its updated
    // result, or refresh the cache from the entry that rejected this repair.
    return deriveRepairResult(persistedEntry ?? comparedEntry ?? entry);
  } catch (error) {
    // An interleaved write changed the row between preparation and commit. Adopt the
    // newer persisted state rather than failing the turn; it is authoritative.
    if (isSqliteSessionMutationConflictError(error)) {
      const reloaded = await loadSessionEntryReadOnly({ storePath, sessionKey });
      return deriveRepairResult(reloaded ?? observedSnapshot);
    }
    throw error;
  }
}

function prepareRepairedEntry(params: {
  observedSnapshot: SessionEntry;
  repairKind: StaleAutoFallbackOriginRepairKind;
  primaryProvider: string;
  primaryModel: string;
}): SessionEntry {
  const { observedSnapshot, repairKind, primaryProvider, primaryModel } = params;
  const entry = { ...observedSnapshot };
  if (repairKind === "clear-override") {
    applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: primaryProvider, model: primaryModel, isDefault: true },
    });
  } else {
    entry.modelOverrideFallbackOriginProvider = primaryProvider;
    entry.modelOverrideFallbackOriginModel = primaryModel;
  }
  return entry;
}

function isSqliteSessionMutationConflictError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "SqliteSessionMutationConflictError"
  );
}

function deriveRepairResult(entry: SessionEntry): StaleAutoFallbackOriginRepairResult {
  const hasStoredOverride = Boolean(entry.modelOverride || entry.providerOverride);
  return {
    entry,
    hasStoredOverride,
    storedModelOverrideSource: hasStoredOverride ? entry.modelOverrideSource : undefined,
    storedModelOverrideRouteResolution: hasStoredOverride
      ? resolveSessionModelOverrideRouteResolution(entry)
      : undefined,
    hasStoredAutoFallbackProvenance:
      hasStoredOverride && hasSessionAutoModelFallbackProvenance(entry),
    hasLegacyAutoFallbackOverrideWithoutOrigin:
      hasStoredOverride && hasLegacyAutoFallbackWithoutOrigin(entry),
  };
}

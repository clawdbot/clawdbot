import { resolveSessionModelOverrideRouteResolution } from "../../config/sessions/model-override-provenance.js";
/** Atomic repair for automatic-fallback overrides whose recorded origin no longer
 *  matches the configured primary. The write is guarded by the exact observed
 *  snapshot so a concurrent reset, user selection, or newer automatic fallback
 *  does not receive stale origin-clear metadata. */
import { patchSessionEntry } from "../../config/sessions/session-accessor.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionAutoModelFallbackProvenance,
  isStaleAutoFallbackOriginOverride,
  matchesStaleAutoFallbackOriginRepairSnapshot,
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
  if (!isStaleAutoFallbackOriginOverride(observedSnapshot, primaryProvider, primaryModel)) {
    return deriveRepairResult(observedSnapshot);
  }
  const entry = { ...observedSnapshot };
  const { updated } = applyModelOverrideToSessionEntry({
    entry,
    selection: { provider: primaryProvider, model: primaryModel, isDefault: true },
  });
  if (!updated) {
    return deriveRepairResult(observedSnapshot);
  }
  if (!storePath) {
    return deriveRepairResult(entry);
  }
  let comparedEntry: SessionEntry | undefined;
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

import { resolveSessionAuthProfileOverrideSource } from "./auth-profile-override-provenance.js";
import type { SessionPatchProjectionSnapshot } from "./session-accessor.types.js";
import type { SessionEntry } from "./types.js";

type SessionProjectionTarget = {
  candidateKeys?: readonly string[];
  primaryKey: string;
};

/** Carries only user/runtime selection into a new dashboard fork. */
export function inheritSessionSelection(
  parentEntry: SessionEntry | undefined,
): Partial<SessionEntry> {
  if (!parentEntry) {
    return {};
  }
  const authProfileOverrideSource = resolveSessionAuthProfileOverrideSource(parentEntry);
  return {
    ...(parentEntry.providerOverride ? { providerOverride: parentEntry.providerOverride } : {}),
    ...(parentEntry.modelOverride ? { modelOverride: parentEntry.modelOverride } : {}),
    ...(parentEntry.modelOverrideSource
      ? { modelOverrideSource: parentEntry.modelOverrideSource }
      : {}),
    ...(parentEntry.modelOverrideRouteResolution
      ? { modelOverrideRouteResolution: parentEntry.modelOverrideRouteResolution }
      : {}),
    ...(parentEntry.agentRuntimeOverride
      ? { agentRuntimeOverride: parentEntry.agentRuntimeOverride }
      : {}),
    ...(parentEntry.thinkingLevel ? { thinkingLevel: parentEntry.thinkingLevel } : {}),
    ...(parentEntry.fastMode !== undefined ? { fastMode: parentEntry.fastMode } : {}),
    ...(parentEntry.toolOverrides ? { toolOverrides: parentEntry.toolOverrides } : {}),
    ...(parentEntry.verboseLevel ? { verboseLevel: parentEntry.verboseLevel } : {}),
    ...(parentEntry.traceLevel ? { traceLevel: parentEntry.traceLevel } : {}),
    ...(parentEntry.reasoningLevel ? { reasoningLevel: parentEntry.reasoningLevel } : {}),
    ...(parentEntry.elevatedLevel ? { elevatedLevel: parentEntry.elevatedLevel } : {}),
    ...(authProfileOverrideSource && parentEntry.authProfileOverride
      ? { authProfileOverride: parentEntry.authProfileOverride }
      : {}),
    ...(authProfileOverrideSource ? { authProfileOverrideSource } : {}),
  };
}

function cloneOptionalSessionEntry(entry: SessionEntry | undefined): SessionEntry | undefined {
  return entry ? structuredClone(entry) : undefined;
}

export function resolveProjectionExistingEntry(
  snapshot: SessionPatchProjectionSnapshot,
  target: SessionProjectionTarget,
): SessionEntry | undefined {
  const candidateKeys = target.candidateKeys ?? [target.primaryKey];
  let freshest: SessionEntry | undefined;
  for (const candidateKey of candidateKeys) {
    const entry = snapshot.store[candidateKey];
    if (entry && (!freshest || (entry.updatedAt ?? 0) > (freshest.updatedAt ?? 0))) {
      freshest = entry;
    }
  }
  return cloneOptionalSessionEntry(freshest);
}

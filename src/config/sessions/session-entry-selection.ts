import { resolveSessionAuthProfileOverrideSource } from "./auth-profile-override-provenance.js";
import type { SessionPatchProjectionSnapshot } from "./session-accessor.types.js";
import type { SessionEntry } from "./types.js";

type SessionProjectionTarget = {
  candidateKeys?: readonly string[];
  primaryKey: string;
};

export class SessionLabelOwnerIndex {
  readonly #owners = new Map<string, Set<string>>();

  constructor(private readonly store: Record<string, SessionEntry>) {
    for (const [sessionKey, entry] of Object.entries(this.store)) {
      this.#update(sessionKey, entry.label, true);
    }
  }

  isLabelInUse(label: string, excludedKeys: readonly string[]): boolean {
    for (const sessionKey of this.#owners.get(label) ?? []) {
      if (!excludedKeys.includes(sessionKey)) {
        return true;
      }
    }
    return false;
  }

  replaceEntry(
    candidateKeys: readonly string[],
    primaryKey: string,
    entry: SessionEntry,
  ): SessionEntry {
    for (const sessionKey of new Set([...candidateKeys, primaryKey])) {
      this.#update(sessionKey, this.store[sessionKey]?.label, false);
      delete this.store[sessionKey];
    }
    const cloned = structuredClone(entry);
    this.store[primaryKey] = cloned;
    this.#update(primaryKey, cloned.label, true);
    return cloned;
  }

  #update(sessionKey: string, label: string | undefined, add: boolean): void {
    if (label === undefined) {
      return;
    }
    const owners = this.#owners.get(label) ?? new Set<string>();
    if (add) {
      owners.add(sessionKey);
      this.#owners.set(label, owners);
      return;
    }
    owners.delete(sessionKey);
  }
}

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

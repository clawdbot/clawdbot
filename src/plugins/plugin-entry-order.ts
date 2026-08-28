type PluginEntryIdentity = {
  id: string;
  pluginId: string;
};

type PluginAutoDetectEntry = PluginEntryIdentity & {
  autoDetectOrder?: number;
};

function comparePluginEntryIdentity(left: PluginEntryIdentity, right: PluginEntryIdentity): number {
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

export function sortPluginEntriesById<T extends PluginEntryIdentity>(entries: readonly T[]): T[] {
  return entries.toSorted(comparePluginEntryIdentity);
}

/** Sorts auto-detect candidates by priority, then stable plugin identity. */
export function sortPluginEntriesForAutoDetect<T extends PluginAutoDetectEntry>(
  entries: readonly T[],
): T[] {
  return entries.toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return comparePluginEntryIdentity(left, right);
  });
}

import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

export type VisibleTranscriptEventEntry<T> = {
  event: T;
  /** Parent id after active-branch normalization; null when no visible parent exists. */
  parentId: string | null;
  seq: number;
};

/** Selects the active visible branch while preserving original transcript sequence numbers. */
export function selectVisibleTranscriptEventEntries<T>(
  events: readonly T[],
): VisibleTranscriptEventEntry<T>[] {
  const tree = scanSessionTranscriptTree(events);
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  if (visiblePath.length > 0) {
    return visiblePath.map((node) => ({
      event: node.entry,
      parentId: node.parentId,
      seq: node.index + 1,
    }));
  }
  return tree.hasLeafControl
    ? []
    : events.map((event, index) => ({ event, parentId: null, seq: index + 1 }));
}

/** Selects only events on the active visible transcript branch. */
export function selectVisibleTranscriptEvents<T>(events: readonly T[]): T[] {
  return selectVisibleTranscriptEventEntries(events).map((entry) => entry.event);
}

/** Resolves the parent id that the next active transcript append should use. */
export function resolveVisibleTranscriptAppendParentId(events: readonly unknown[]): string | null {
  return scanSessionTranscriptTree(events).appendParentId;
}

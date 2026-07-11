// Transcript tree helpers keep append-only leaf controls consistent across readers.
type TranscriptRecord = Record<string, unknown>;

export type SessionTranscriptTreeEntry = {
  id: string;
  parentId: string | null;
  leafId: string | null | undefined;
  appendParentId: string | null;
  appendMode?: "side";
};

export type SessionTranscriptTreeNode<T> = SessionTranscriptTreeEntry & {
  entry: T;
  index: number;
};

export type SessionTranscriptTree<T> = {
  nodes: SessionTranscriptTreeNode<T>[];
  byId: Map<string, SessionTranscriptTreeNode<T>>;
  leafId: string | null;
  appendParentId: string | null;
  hasLeafControl: boolean;
  hasLeafUpdate: boolean;
  hasExplicitLeafUpdate: boolean;
  hasInvalidLeafControl: boolean;
};

function isRecord(value: unknown): value is TranscriptRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isCanonicalSessionEntryType(value: unknown): boolean {
  switch (value) {
    case "message":
    case "thinking_level_change":
    case "model_change":
    case "compaction":
    case "branch_summary":
    case "custom":
    case "custom_message":
    case "label":
    case "session_info":
      return true;
    default:
      return false;
  }
}

export function isCanonicalSessionTranscriptEntry(
  record: unknown,
): record is TranscriptRecord & { type: string } {
  return isRecord(record) && isCanonicalSessionEntryType(record.type);
}

export function isSessionTranscriptSideAppendEntry(record: unknown): boolean {
  return isCanonicalSessionTranscriptEntry(record) && record.appendMode === "side";
}

export function isSessionTranscriptLeafControl(
  record: unknown,
): record is TranscriptRecord & { type: "leaf" } {
  return (
    isRecord(record) &&
    record.type === "leaf" &&
    parseSessionTranscriptTreeEntry(record) !== undefined
  );
}

/**
 * Parse one parent-linked transcript row.
 *
 * Leaf rows are navigation controls: they select targetId as the active leaf,
 * and descendants that reference the marker continue through that same target.
 */
export function parseSessionTranscriptTreeEntry(
  record: unknown,
): SessionTranscriptTreeEntry | undefined {
  if (!isRecord(record) || record.type === "session" || !Object.hasOwn(record, "parentId")) {
    return undefined;
  }
  const id = readNonEmptyString(record.id);
  const parentId =
    record.parentId === null ? null : (readNonEmptyString(record.parentId) ?? undefined);
  if (!id || parentId === undefined) {
    return undefined;
  }
  if (record.type === "leaf") {
    const targetId =
      record.targetId === null ? null : (readNonEmptyString(record.targetId) ?? undefined);
    const appendParentId =
      record.appendParentId === undefined
        ? targetId
        : record.appendParentId === null
          ? null
          : (readNonEmptyString(record.appendParentId) ?? undefined);
    const appendMode =
      record.appendMode === undefined ? undefined : record.appendMode === "side" ? "side" : null;
    return targetId === undefined || appendParentId === undefined || appendMode === null
      ? undefined
      : {
          id,
          parentId: targetId,
          leafId: targetId,
          appendParentId,
          ...(appendMode ? { appendMode } : {}),
        };
  }
  return {
    id,
    parentId,
    leafId:
      isCanonicalSessionTranscriptEntry(record) && record.appendMode !== "side" ? id : undefined,
    appendParentId: id,
    ...(record.appendMode === "side" ? { appendMode: record.appendMode } : {}),
  };
}

function parseParentlessCanonicalEntry(
  record: unknown,
  parentId: string | null,
): SessionTranscriptTreeEntry | undefined {
  if (!isCanonicalSessionTranscriptEntry(record) || Object.hasOwn(record, "parentId")) {
    return undefined;
  }
  const id = readNonEmptyString(record.id);
  return id
    ? {
        id,
        parentId,
        leafId: record.appendMode === "side" ? undefined : id,
        appendParentId: id,
        ...(record.appendMode === "side" ? { appendMode: record.appendMode } : {}),
      }
    : undefined;
}

function resolveCanonicalParentId<T>(
  parentId: string | null,
  byId: ReadonlyMap<string, SessionTranscriptTreeNode<T>>,
): string | null {
  const seen = new Set<string>();
  let currentId = parentId;
  while (currentId !== null) {
    if (seen.has(currentId)) {
      return currentId;
    }
    seen.add(currentId);
    const parent = byId.get(currentId);
    if (!parent || !isSessionTranscriptLeafControl(parent.entry)) {
      return currentId;
    }
    // Leaf controls are omitted from selected paths, so descendants must point
    // through the marker to its normalized visible parent.
    currentId = parent.parentId;
  }
  return null;
}

/**
 * Resolve transcript navigation state in file order.
 *
 * Current-version transcripts can contain parentless canonical rows written by
 * older appenders. Treat those rows as a linear continuation of the current
 * append cursor so a later leaf control can still address their full history.
 */
export function scanSessionTranscriptTree<T>(entries: readonly T[]): SessionTranscriptTree<T> {
  const nodes: SessionTranscriptTreeNode<T>[] = [];
  const byId = new Map<string, SessionTranscriptTreeNode<T>>();
  let leafId: string | null = null;
  let appendParentId: string | null = null;
  let hasLeafControl = false;
  let hasLeafUpdate = false;
  let hasExplicitLeafUpdate = false;
  let hasInvalidLeafControl = false;
  const invalidLeafControlIds = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const explicitTreeEntry = parseSessionTranscriptTreeEntry(entry);
    const isKnownLeafReference = (id: string | null): boolean =>
      id === null || (byId.has(id) && !invalidLeafControlIds.has(id));
    const invalidLeafControl =
      explicitTreeEntry?.leafId !== undefined &&
      isSessionTranscriptLeafControl(entry) &&
      (!isKnownLeafReference(explicitTreeEntry.leafId) ||
        !isKnownLeafReference(explicitTreeEntry.appendParentId));
    if (invalidLeafControl) {
      hasInvalidLeafControl = true;
      invalidLeafControlIds.add(explicitTreeEntry.id);
      const rawParentId = (entry as TranscriptRecord).parentId as string | null;
      const node: SessionTranscriptTreeNode<T> = {
        ...explicitTreeEntry,
        parentId: rawParentId,
        leafId: undefined,
        appendParentId,
        entry,
        index,
      };
      // Invalid controls are transparent structural markers. Descendants can
      // repair through their raw parent, but navigation state does not change.
      nodes.push(node);
      byId.set(node.id, node);
      continue;
    }
    let treeEntry: SessionTranscriptTreeEntry | undefined =
      explicitTreeEntry ?? parseParentlessCanonicalEntry(entry, leafId);
    if (treeEntry && isCanonicalSessionTranscriptEntry(entry)) {
      const canonicalParentIsStale =
        explicitTreeEntry &&
        treeEntry.parentId !== null &&
        !byId.has(treeEntry.parentId) &&
        leafId !== null;
      const logicalParentId =
        treeEntry.appendMode !== "side" && canonicalParentIsStale
          ? leafId
          : explicitTreeEntry &&
              treeEntry.appendMode !== "side" &&
              treeEntry.parentId === appendParentId &&
              leafId !== appendParentId
            ? leafId
            : treeEntry.parentId;
      const normalizedParentId = resolveCanonicalParentId(logicalParentId, byId);
      if (normalizedParentId !== treeEntry.parentId) {
        // The raw cursor can belong to plugin metadata, an inactive branch, or
        // an omitted leaf marker. Keep physical append state separate from the
        // visible ancestry consumed by context builders.
        treeEntry = { ...treeEntry, parentId: normalizedParentId };
      }
    }
    if (!treeEntry) {
      continue;
    }
    const node: SessionTranscriptTreeNode<T> = { ...treeEntry, entry, index };
    nodes.push(node);
    byId.set(node.id, node);
    appendParentId = node.appendParentId;
    if (node.leafId !== undefined) {
      leafId = node.leafId;
      hasLeafUpdate = true;
      if (explicitTreeEntry) {
        hasExplicitLeafUpdate = true;
      }
    }
    if (isSessionTranscriptLeafControl(entry)) {
      hasLeafControl = true;
    }
  }

  return {
    nodes,
    byId,
    leafId,
    appendParentId,
    hasLeafControl,
    hasLeafUpdate,
    hasExplicitLeafUpdate,
    hasInvalidLeafControl,
  };
}

/** Select one normalized path, retaining a reachable suffix after missing ancestors. */
export function selectSessionTranscriptTreePathNodes<T>(
  tree: SessionTranscriptTree<T>,
  leafId: string | null,
): SessionTranscriptTreeNode<T>[] {
  if (leafId === null) {
    return [];
  }
  const path: SessionTranscriptTreeNode<T>[] = [];
  const seen = new Set<string>();
  let currentId: string | null = leafId;
  while (currentId) {
    if (seen.has(currentId)) {
      return [];
    }
    seen.add(currentId);
    const current = tree.byId.get(currentId);
    if (!current) {
      break;
    }
    if (!isSessionTranscriptLeafControl(current.entry)) {
      path.unshift(current);
    }
    currentId = current.parentId;
  }
  return path;
}

/** Merge normalized paths in original file order and expose their retained parent links. */
export function mergeSessionTranscriptTreePaths<T>(
  paths: Array<SessionTranscriptTreeNode<T>[]>,
): Array<SessionTranscriptTreeNode<T> & { selectedParentId: string | null }> {
  const selectedById = new Map<
    string,
    SessionTranscriptTreeNode<T> & { selectedParentId: string | null }
  >();
  for (const path of paths) {
    let selectedParentId: string | null = null;
    for (const node of path) {
      selectedById.set(node.id, { ...node, selectedParentId });
      selectedParentId = node.id;
    }
  }
  return [...selectedById.values()].toSorted((left, right) => left.index - right.index);
}

/**
 * Build a copy-safe branch from the visible path and the opaque append suffix.
 *
 * Hidden canonical append ancestors must not leak into forks or repairs. Keep
 * only opaque cursor records after the last canonical ancestor and reparent
 * that suffix onto the selected visible path.
 */
export function mergeSessionTranscriptVisiblePathWithOpaqueAppendPath<T>(params: {
  visiblePath: SessionTranscriptTreeNode<T>[];
  appendPath: SessionTranscriptTreeNode<T>[];
  appendParentId: string | null;
}): {
  nodes: Array<SessionTranscriptTreeNode<T> & { selectedParentId: string | null }>;
  appendParentId: string | null;
} {
  const nodes = mergeSessionTranscriptTreePaths([params.visiblePath]);
  const selectedIds = new Set(nodes.map((node) => node.id));
  const opaqueSuffix: SessionTranscriptTreeNode<T>[] = [];
  for (let index = params.appendPath.length - 1; index >= 0; index -= 1) {
    const node = params.appendPath[index];
    if (!node || selectedIds.has(node.id) || isCanonicalSessionTranscriptEntry(node.entry)) {
      break;
    }
    opaqueSuffix.unshift(node);
  }

  let selectedParentId = nodes.at(-1)?.id ?? null;
  for (const node of opaqueSuffix) {
    nodes.push({ ...node, selectedParentId });
    selectedIds.add(node.id);
    selectedParentId = node.id;
  }

  return {
    nodes,
    appendParentId:
      params.appendParentId === null
        ? null
        : selectedIds.has(params.appendParentId)
          ? params.appendParentId
          : (nodes.at(-1)?.id ?? null),
  };
}

/**
 * Select the effective branch only when the transcript contains leaf controls.
 *
 * Legacy flat readers can keep their existing behavior when this returns
 * undefined. Once navigation controls exist, returning the selected path keeps
 * side branches out of prompts and hooks even after later active-branch appends.
 */
export function selectSessionTranscriptLeafControlledPath<T>(
  entries: readonly T[],
): T[] | undefined {
  const tree = scanSessionTranscriptTree(entries);
  if (!tree.hasLeafControl) {
    return undefined;
  }
  return selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => {
    if (!isRecord(node.entry) || node.entry.parentId === node.parentId) {
      return node.entry;
    }
    // Consumers rebuild context from the selected entries, so preserve the
    // logical ancestry normalized while scanning disjoint append cursors.
    return Object.assign({}, node.entry, { parentId: node.parentId }) as T;
  });
}

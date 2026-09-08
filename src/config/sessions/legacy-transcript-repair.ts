import { isRecord } from "@openclaw/normalization-core/record-coerce";
/** Pure legacy transcript repair shared by standalone Doctor and its import spool. */
import {
  hasInternalRuntimeContext,
  stripInternalRuntimeContext,
} from "../../agents/internal-runtime-context.js";
import { isLegacyCodexProviderId } from "../legacy-codex-provider.js";
import {
  isSessionTranscriptLeafControl,
  mergeSessionTranscriptTreePaths,
  mergeSessionTranscriptVisiblePathWithOpaqueAppendPath,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";
export type TranscriptEntry = Record<string, unknown> & {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  message?: unknown;
};
type ActiveTranscriptPath = {
  entries: TranscriptEntry[];
  entriesToPersist: TranscriptEntry[];
  terminalLeafControl: TranscriptEntry | null;
  appendParentId: string | null;
};
const OPENAI_PROVIDER_ID = "openai";
const LEGACY_OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const OPENAI_CHATGPT_RESPONSES_API = "openai-chatgpt-responses";
function getEntryId(entry: TranscriptEntry): string | null {
  return typeof entry.id === "string" && entry.id.trim() ? entry.id : null;
}

function getParentId(entry: TranscriptEntry): string | null {
  return typeof entry.parentId === "string" && entry.parentId.trim() ? entry.parentId : null;
}

function getMessage(entry: TranscriptEntry): Record<string, unknown> | null {
  return isRecord(entry.message) ? entry.message : null;
}

function withSelectedParent(entry: TranscriptEntry, parentId: string | null): TranscriptEntry {
  return entry.parentId === parentId ? entry : { ...entry, parentId };
}

export function normalizeLegacyOpenAICodexTranscriptMetadata(entries: TranscriptEntry[]): number {
  let changed = 0;
  for (const entry of entries) {
    const message = getMessage(entry);
    if (!message) {
      continue;
    }
    let touched = false;
    if (isLegacyCodexProviderId(message.provider)) {
      message.provider = OPENAI_PROVIDER_ID;
      touched = true;
    }
    if (message.api === LEGACY_OPENAI_CODEX_RESPONSES_API) {
      message.api = OPENAI_CHATGPT_RESPONSES_API;
      touched = true;
    }
    if (touched) {
      changed += 1;
    }
  }
  return changed;
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
  return text || null;
}

export function selectActivePath(entries: TranscriptEntry[]): ActiveTranscriptPath | null {
  const sessionEntries = entries.filter((entry) => entry.type !== "session");
  const tree = scanSessionTranscriptTree(sessionEntries);
  if (!tree.hasExplicitLeafUpdate) {
    const byId = new Map<string, TranscriptEntry>();
    for (const entry of sessionEntries) {
      const id = getEntryId(entry);
      if (id) {
        byId.set(id, entry);
      }
    }
    const active: TranscriptEntry[] = [];
    const seen = new Set<string>();
    let current = sessionEntries.at(-1);
    while (current) {
      const id = getEntryId(current);
      if (!id || seen.has(id)) {
        return null;
      }
      seen.add(id);
      active.unshift(current);
      const parentId = getParentId(current);
      current = parentId ? byId.get(parentId) : undefined;
    }
    return active.length > 0
      ? {
          entries: active,
          entriesToPersist: active,
          terminalLeafControl: null,
          appendParentId: getEntryId(active.at(-1) ?? {}),
        }
      : null;
  }
  if (!tree.hasLeafUpdate) {
    return null;
  }
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const appendPath = selectSessionTranscriptTreePathNodes(tree, tree.appendParentId);
  const visibleEntries = mergeSessionTranscriptTreePaths([visiblePath]).map((node) =>
    withSelectedParent(node.entry, node.selectedParentId),
  );
  const persistedPath = mergeSessionTranscriptVisiblePathWithOpaqueAppendPath({
    visiblePath,
    appendPath,
    appendParentId: tree.appendParentId,
  });
  const entriesToPersist = persistedPath.nodes.map((node) =>
    withSelectedParent(node.entry, node.selectedParentId),
  );
  const lastLeafUpdateEntry = tree.nodes.findLast((node) => node.leafId !== undefined)?.entry;
  const terminalLeafControl = isSessionTranscriptLeafControl(lastLeafUpdateEntry)
    ? lastLeafUpdateEntry
    : null;
  return {
    entries: visibleEntries,
    entriesToPersist,
    terminalLeafControl,
    appendParentId: persistedPath.appendParentId,
  };
}

export function hasBrokenPromptRewriteBranch(
  entries: TranscriptEntry[],
  activePath: TranscriptEntry[],
) {
  const activeIds = new Set(activePath.map(getEntryId).filter((id): id is string => Boolean(id)));
  const keys = new Set(
    activePath
      .map((entry) => transcriptRepairUserKey(entry, false))
      .filter((key) => key !== undefined),
  );
  return entries.some(
    (entry) =>
      !activeIds.has(getEntryId(entry) ?? "") &&
      keys.has(transcriptRepairUserKey(entry, true) ?? ""),
  );
}

export function selectActiveTranscriptEntries(params: {
  entries: TranscriptEntry[];
  activePath: ActiveTranscriptPath;
}): TranscriptEntry[] {
  const header = params.entries.find((entry) => entry.type === "session");
  if (!header) {
    throw new Error("missing session header");
  }
  const lastPersistedId = getEntryId(params.activePath.entriesToPersist.at(-1) ?? {});
  const terminalLeafControl = params.activePath.terminalLeafControl
    ? {
        ...params.activePath.terminalLeafControl,
        parentId: lastPersistedId,
        appendParentId: params.activePath.appendParentId,
      }
    : null;
  return [
    header,
    ...params.activePath.entriesToPersist,
    ...(terminalLeafControl ? [terminalLeafControl] : []),
  ];
}

export function transcriptRepairUserKey(
  entry: TranscriptEntry,
  strip: boolean,
): string | undefined {
  const message = getMessage(entry);
  if (!getEntryId(entry) || message?.role !== "user") {
    return undefined;
  }
  const text = textFromContent(message.content);
  if (text === null || (strip && !hasInternalRuntimeContext(text))) {
    return undefined;
  }
  const visible = (strip ? stripInternalRuntimeContext(text) : text).trim();
  return visible ? `${getParentId(entry) ?? ""}\0${visible}` : undefined;
}

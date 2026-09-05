import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  memoryCoreStateReference,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import type {
  ShortTermPhaseSignalEntry,
  ShortTermPhaseSignalStore,
  ShortTermRecallStore,
  ShortTermStoreMeta,
} from "./short-term-promotion-types.js";
import {
  enforceShortTermRecallSnippetCap,
  enforceShortTermRecallStoreRetention,
  normalizeShortTermRecallStore,
  toFiniteNonNegativeInt,
} from "./short-term-promotion-utils.js";

const SHORT_TERM_STORE_NAMESPACES = {
  recall: SHORT_TERM_RECALL_NAMESPACE,
  phase: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
};

export async function readShortTermStore(
  workspaceDir: string,
  kind: keyof typeof SHORT_TERM_STORE_NAMESPACES,
  nowIso: string,
) {
  const [entryRows, metaRows] = await Promise.all([
    readMemoryCoreWorkspaceEntries<unknown>({
      namespace: SHORT_TERM_STORE_NAMESPACES[kind],
      workspaceDir,
    }),
    readMemoryCoreWorkspaceEntries<ShortTermStoreMeta>({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir,
    }),
  ]);
  return {
    version: 1,
    updatedAt: metaRows.find((entry) => entry.key === kind)?.value?.updatedAt ?? nowIso,
    entries: Object.fromEntries(entryRows.map((entry) => [entry.key, entry.value])),
  };
}

async function writeShortTermStore(
  workspaceDir: string,
  kind: keyof typeof SHORT_TERM_STORE_NAMESPACES,
  store: ShortTermRecallStore | ShortTermPhaseSignalStore,
): Promise<void> {
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_STORE_NAMESPACES[kind],
      workspaceDir,
      entries: Object.entries(store.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir,
      key: kind,
      value: { updatedAt: store.updatedAt },
    }),
  ]);
}

export function resolveStorePath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_RECALL_NAMESPACE, workspaceDir);
}

export function resolvePhaseSignalPath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_PHASE_SIGNAL_NAMESPACE, workspaceDir);
}

export async function readStore(
  workspaceDir: string,
  nowIso: string,
): Promise<ShortTermRecallStore> {
  const store = normalizeShortTermRecallStore(
    await readShortTermStore(workspaceDir, "recall", nowIso),
    nowIso,
  );
  enforceShortTermRecallStoreRetention(store);
  return store;
}

export function emptyPhaseSignalStore(nowIso: string): ShortTermPhaseSignalStore {
  return {
    version: 1,
    updatedAt: nowIso,
    entries: {},
  };
}

export function normalizeShortTermPhaseSignalStore(
  raw: unknown,
  nowIso: string,
): ShortTermPhaseSignalStore {
  const record = asNullableRecord(raw);
  if (!record) {
    return emptyPhaseSignalStore(nowIso);
  }
  const entriesRaw = asNullableRecord(record?.entries);
  if (!entriesRaw) {
    return emptyPhaseSignalStore(nowIso);
  }
  const entries: Record<string, ShortTermPhaseSignalEntry> = {};
  for (const [mapKey, value] of Object.entries(entriesRaw)) {
    const entry = asNullableRecord(value);
    if (!entry) {
      continue;
    }
    const key = typeof entry.key === "string" && entry.key.trim().length > 0 ? entry.key : mapKey;
    const lightHits = toFiniteNonNegativeInt(entry.lightHits, 0);
    const remHits = toFiniteNonNegativeInt(entry.remHits, 0);
    if (lightHits === 0 && remHits === 0) {
      continue;
    }
    const lastLightAt =
      typeof entry.lastLightAt === "string" && entry.lastLightAt.trim().length > 0
        ? entry.lastLightAt
        : undefined;
    const lastRemAt =
      typeof entry.lastRemAt === "string" && entry.lastRemAt.trim().length > 0
        ? entry.lastRemAt
        : undefined;
    const lastRemConsideredAt =
      typeof entry.lastRemConsideredAt === "string" && entry.lastRemConsideredAt.trim().length > 0
        ? entry.lastRemConsideredAt
        : undefined;
    entries[key] = {
      key,
      lightHits,
      remHits,
      ...(lastLightAt ? { lastLightAt } : {}),
      ...(lastRemAt ? { lastRemAt } : {}),
      ...(lastRemConsideredAt ? { lastRemConsideredAt } : {}),
    };
  }
  return {
    version: 1,
    updatedAt:
      typeof record.updatedAt === "string" && record.updatedAt.trim().length > 0
        ? record.updatedAt
        : nowIso,
    entries,
  };
}

export async function readPhaseSignalStore(
  workspaceDir: string,
  nowIso: string,
): Promise<ShortTermPhaseSignalStore> {
  return normalizeShortTermPhaseSignalStore(
    await readShortTermStore(workspaceDir, "phase", nowIso),
    nowIso,
  );
}

export async function writePhaseSignalStore(
  workspaceDir: string,
  store: ShortTermPhaseSignalStore,
): Promise<void> {
  await writeShortTermStore(workspaceDir, "phase", store);
}

export async function writeStore(workspaceDir: string, store: ShortTermRecallStore): Promise<void> {
  enforceShortTermRecallSnippetCap(store);
  enforceShortTermRecallStoreRetention(store);
  await writeShortTermStore(workspaceDir, "recall", store);
}

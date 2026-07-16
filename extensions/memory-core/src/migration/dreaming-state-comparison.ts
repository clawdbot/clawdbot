import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeDailyIngestionState,
  normalizeSessionIngestionState,
} from "../dreaming-phases.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "../dreaming-state.js";
import {
  normalizeShortTermPhaseSignalStore,
  normalizeShortTermRecallStore,
} from "../short-term-promotion.js";

type LegacyDreamingSource = {
  workspaceDir: string;
  label: string;
  filePath: string;
};

const LEGACY_SOURCE_ACKNOWLEDGEMENT_NAMESPACE = "legacy-dreaming-source-acknowledgements";

function targetNamespacesForSource(label: string): string[] {
  if (label === "daily ingestion") {
    return [DREAMING_DAILY_INGESTION_NAMESPACE];
  }
  if (label === "session ingestion") {
    return [DREAMING_SESSION_INGESTION_FILES_NAMESPACE, DREAMING_SESSION_INGESTION_SEEN_NAMESPACE];
  }
  return [
    label === "short-term recall" ? SHORT_TERM_RECALL_NAMESPACE : SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function memoryCoreLegacyTargetHasRows(source: LegacyDreamingSource): Promise<boolean> {
  const counts = await Promise.all(
    targetNamespacesForSource(source.label).map(
      async (namespace) =>
        (
          await readMemoryCoreWorkspaceEntries({
            namespace,
            workspaceDir: source.workspaceDir,
          })
        ).length,
    ),
  );
  return counts.some((count) => count > 0);
}

async function memoryCoreLegacySourceMatchesCanonical(
  source: LegacyDreamingSource,
  raw: unknown,
): Promise<boolean> {
  if (source.label === "daily ingestion") {
    const rows = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir: source.workspaceDir,
    });
    return isDeepStrictEqual(
      normalizeDailyIngestionState(raw),
      normalizeDailyIngestionState({
        version: 1,
        files: Object.fromEntries(rows.map((row) => [row.key, row.value])),
      }),
    );
  }
  if (source.label === "session ingestion") {
    const [fileRows, seenRows] = await Promise.all([
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        workspaceDir: source.workspaceDir,
      }),
      readMemoryCoreWorkspaceEntries<{ scope: string; index: number; hashes: string[] }>({
        namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
        workspaceDir: source.workspaceDir,
      }),
    ]);
    const chunksByScope = new Map<string, Array<{ index: number; hashes: string[] }>>();
    for (const row of seenRows) {
      const chunks = chunksByScope.get(row.value.scope) ?? [];
      chunks.push({ index: row.value.index, hashes: row.value.hashes });
      chunksByScope.set(row.value.scope, chunks);
    }
    return isDeepStrictEqual(
      normalizeSessionIngestionState(raw),
      normalizeSessionIngestionState({
        version: 3,
        files: Object.fromEntries(fileRows.map((row) => [row.key, row.value])),
        seenMessages: Object.fromEntries(
          [...chunksByScope].map(([scope, chunks]) => [
            scope,
            chunks.toSorted((left, right) => left.index - right.index).flatMap((row) => row.hashes),
          ]),
        ),
      }),
    );
  }
  const [entryRows, metaRows] = await Promise.all([
    readMemoryCoreWorkspaceEntries({
      namespace:
        source.label === "short-term recall"
          ? SHORT_TERM_RECALL_NAMESPACE
          : SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      workspaceDir: source.workspaceDir,
    }),
    readMemoryCoreWorkspaceEntries<{ updatedAt?: unknown }>({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: source.workspaceDir,
    }),
  ]);
  const metaKey = source.label === "short-term recall" ? "recall" : "phase";
  const updatedAt = metaRows.find((row) => row.key === metaKey)?.value.updatedAt;
  if (typeof updatedAt !== "string" || updatedAt.length === 0) {
    return false;
  }
  const canonicalRaw = {
    version: 1,
    updatedAt,
    entries: Object.fromEntries(entryRows.map((row) => [row.key, row.value])),
  };
  if (source.label === "short-term recall") {
    const canonical = normalizeShortTermRecallStore(canonicalRaw, updatedAt);
    const fallbackCandidates = new Set([updatedAt]);
    for (const row of entryRows) {
      const value = asRecord(row.value);
      for (const key of ["firstRecalledAt", "lastRecalledAt"] as const) {
        if (typeof value?.[key] === "string") {
          fallbackCandidates.add(value[key]);
        }
      }
    }
    // Missing legacy timestamps received one migration-time value, preserved only in rows.
    return [...fallbackCandidates].some((fallback) =>
      isDeepStrictEqual(normalizeShortTermRecallStore(raw, fallback), canonical),
    );
  }
  return isDeepStrictEqual(
    normalizeShortTermPhaseSignalStore(raw, updatedAt),
    normalizeShortTermPhaseSignalStore(canonicalRaw, updatedAt),
  );
}

async function memoryCoreLegacySourceIsAcknowledged(
  source: LegacyDreamingSource,
): Promise<boolean> {
  const contents = await fs.readFile(source.filePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const markerKey = `legacy-source:${source.label}`;
  const markers = await readMemoryCoreWorkspaceEntries<{ sha256?: unknown }>({
    namespace: LEGACY_SOURCE_ACKNOWLEDGEMENT_NAMESPACE,
    workspaceDir: source.workspaceDir,
  });
  if (markers.find((row) => row.key === markerKey)?.value.sha256 === sha256) {
    return true;
  }
  let archiveNames: string[] = [];
  try {
    const archivePrefix = `${path.basename(source.filePath)}.migrated`;
    archiveNames = (await fs.readdir(path.dirname(source.filePath))).filter((name) => {
      if (name === archivePrefix) {
        return true;
      }
      const suffix = name.slice(archivePrefix.length + 1);
      const archiveIndex = Number(suffix);
      return (
        name.startsWith(`${archivePrefix}.`) &&
        Number.isSafeInteger(archiveIndex) &&
        archiveIndex >= 2 &&
        String(archiveIndex) === suffix
      );
    });
  } catch {
    // The archive is optional provenance; canonical comparison remains authoritative.
  }
  let matchesArchive = false;
  for (const archiveName of archiveNames) {
    try {
      if (
        contents.equals(await fs.readFile(path.join(path.dirname(source.filePath), archiveName)))
      ) {
        matchesArchive = true;
        break;
      }
    } catch {
      // One unreadable archive must not hide another valid provenance snapshot.
    }
  }
  if (
    !matchesArchive &&
    !(await memoryCoreLegacySourceMatchesCanonical(source, JSON.parse(contents.toString("utf8"))))
  ) {
    return false;
  }
  // The migration archive bootstraps existing installs after SQLite has drifted.
  // The stored hash then detects an older process rewriting the rollback source.
  await writeMemoryCoreWorkspaceEntry({
    namespace: LEGACY_SOURCE_ACKNOWLEDGEMENT_NAMESPACE,
    workspaceDir: source.workspaceDir,
    key: markerKey,
    value: { sha256 },
  });
  return true;
}

export const dreamingStateComparison = {
  targetHasRows: memoryCoreLegacyTargetHasRows,
  sourceIsAcknowledged: memoryCoreLegacySourceIsAcknowledged,
};

import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import {
  archiveLegacyStateSource,
  legacyStateFileExists,
} from "openclaw/plugin-sdk/runtime-doctor";
import {
  normalizeDailyIngestionState,
  normalizeSessionIngestionState,
} from "../dreaming-ingestion-state.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  SESSION_SEEN_HASHES_PER_CHUNK,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  configureMemoryCoreDreamingState,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "../dreaming-state.js";
import {
  SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH,
  SHORT_TERM_STORE_RELATIVE_PATH,
  normalizeShortTermPhaseSignalStore,
  normalizeShortTermRecallStore,
} from "../short-term-promotion.js";
import { resolveConfiguredWorkspaces } from "./doctor-workspaces.js";
import { dreamingStateComparison } from "./dreaming-state-comparison.js";

type LegacySource = {
  workspaceDir: string;
  label: string;
  filePath: string;
};

const LEGACY_DAILY_INGESTION_STATE_RELATIVE_PATH = path.join(
  "memory",
  ".dreams",
  "daily-ingestion.json",
);
const LEGACY_SESSION_INGESTION_STATE_RELATIVE_PATH = path.join(
  "memory",
  ".dreams",
  "session-ingestion.json",
);

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function collectLegacySources(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<LegacySource[]> {
  const sources: LegacySource[] = [];
  for (const workspaceDir of resolveConfiguredWorkspaces(config, env)) {
    const candidates = [
      { label: "daily ingestion", relativePath: LEGACY_DAILY_INGESTION_STATE_RELATIVE_PATH },
      { label: "session ingestion", relativePath: LEGACY_SESSION_INGESTION_STATE_RELATIVE_PATH },
      { label: "short-term recall", relativePath: SHORT_TERM_STORE_RELATIVE_PATH },
      { label: "phase signals", relativePath: SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH },
    ];
    for (const candidate of candidates) {
      const filePath = path.join(workspaceDir, candidate.relativePath);
      if (await legacyStateFileExists(filePath)) {
        sources.push({ workspaceDir, label: candidate.label, filePath });
      }
    }
  }
  return sources;
}

async function migrateDailyIngestion(source: LegacySource): Promise<number> {
  const state = normalizeDailyIngestionState(await readJsonFile(source.filePath));
  await writeMemoryCoreWorkspaceEntries({
    namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
    workspaceDir: source.workspaceDir,
    entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
  });
  return Object.keys(state.files).length;
}

async function migrateSessionIngestion(source: LegacySource): Promise<number> {
  const state = normalizeSessionIngestionState(await readJsonFile(source.filePath));
  const seenEntries = Object.entries(state.seenMessages).flatMap(([scope, hashes]) =>
    Array.from(
      { length: Math.ceil(hashes.length / SESSION_SEEN_HASHES_PER_CHUNK) },
      (_, index) => ({
        key: `${scope}:${index}`,
        value: {
          scope,
          index,
          hashes: hashes.slice(
            index * SESSION_SEEN_HASHES_PER_CHUNK,
            (index + 1) * SESSION_SEEN_HASHES_PER_CHUNK,
          ),
        },
      }),
    ),
  );
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: seenEntries,
    }),
  ]);
  return Object.keys(state.files).length + Object.keys(state.seenMessages).length;
}

async function migrateShortTermRecall(source: LegacySource): Promise<number> {
  const nowIso = new Date().toISOString();
  const state = normalizeShortTermRecallStore(await readJsonFile(source.filePath), nowIso);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: Object.entries(state.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: source.workspaceDir,
      key: "recall",
      value: { updatedAt: state.updatedAt },
    }),
  ]);
  return Object.keys(state.entries).length;
}

async function migratePhaseSignals(source: LegacySource): Promise<number> {
  const nowIso = new Date().toISOString();
  const state = normalizeShortTermPhaseSignalStore(await readJsonFile(source.filePath), nowIso);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: Object.entries(state.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: source.workspaceDir,
      key: "phase",
      value: { updatedAt: state.updatedAt },
    }),
  ]);
  return Object.keys(state.entries).length;
}

async function migrateSource(source: LegacySource): Promise<number> {
  if (source.label === "daily ingestion") {
    return await migrateDailyIngestion(source);
  }
  if (source.label === "session ingestion") {
    return await migrateSessionIngestion(source);
  }
  if (source.label === "short-term recall") {
    return await migrateShortTermRecall(source);
  }
  return await migratePhaseSignals(source);
}

export const dreamingStateMigration: PluginDoctorStateMigration = {
  id: "memory-core-dreams-json-to-sqlite",
  label: "Memory Core dreaming state",
  async detectLegacyState(params) {
    configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
    const sources = await collectLegacySources(params.config, params.env);
    if (sources.length === 0) {
      return null;
    }
    return {
      preview: sources.map(
        (source) => `- Memory Core ${source.label}: ${source.filePath} -> SQLite plugin state`,
      ),
    };
  },
  async migrateLegacyState(params) {
    configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
    const changes: string[] = [];
    const warnings: string[] = [];
    const notices: string[] = [];
    for (const source of await collectLegacySources(params.config, params.env)) {
      const targetHasRows = await dreamingStateComparison.targetHasRows(source);
      if (targetHasRows) {
        let sourceAcknowledged: boolean;
        try {
          sourceAcknowledged = await dreamingStateComparison.sourceIsAcknowledged(source);
        } catch (err) {
          warnings.push(
            `Skipped Memory Core ${source.label} import for ${source.workspaceDir} because the legacy source could not be compared: ${String(err)}`,
          );
          continue;
        }
        if (sourceAcknowledged) {
          // Older releases may rewrite these rollback sources. The stored hash
          // keeps unchanged sources informational; rewritten sources fail closed.
          notices.push(
            `Retained acknowledged Memory Core ${source.label} legacy source for rollback: ${source.filePath}`,
          );
          continue;
        }
        // Each retired journal mirrors the SQLite namespaces used by the runtime.
        // Keep canonical state active and retain only the divergent rollback source.
        changes.push(
          `Resolved Memory Core ${source.label} legacy conflict by keeping canonical SQLite plugin state`,
        );
        await archiveLegacyStateSource({
          filePath: source.filePath,
          label: `Memory Core ${source.label} conflicting legacy source`,
          changes,
          warnings,
        });
        continue;
      }
      let imported: number;
      try {
        imported = await migrateSource(source);
      } catch (err) {
        warnings.push(
          `Skipped Memory Core ${source.label} import for ${source.workspaceDir} because the legacy source could not be imported: ${String(err)}`,
        );
        continue;
      }
      changes.push(
        `Migrated Memory Core ${source.label} -> SQLite plugin state (${imported} row(s))`,
      );
      await archiveLegacyStateSource({
        filePath: source.filePath,
        label: `Memory Core ${source.label}`,
        changes,
        warnings,
      });
    }
    return {
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  },
};

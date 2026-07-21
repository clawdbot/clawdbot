import fs from "node:fs";
import { normalizeAgentId, normalizeMainKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import {
  deleteSqliteSessionEntryLifecycle,
  importSqliteSessionRows,
  loadExactSqliteSessionEntry,
  loadSqliteTranscriptEventsSync,
  migrateSqliteSessionEntryKeys,
} from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const LEGACY_IMPLICIT_AGENT_ID = "main";

export type LegacyMainSessionKeyMigrationResult = {
  changes: string[];
  warnings: string[];
};

let pendingMigration:
  | { key: string; promise: Promise<LegacyMainSessionKeyMigrationResult>; settled: boolean }
  | undefined;

function resolveMigrationRoster(
  cfg: OpenClawConfig,
): { defaultAgentId: string; mainKey: string } | { warning?: string } {
  const agents = cfg.agents?.list ?? [];
  if (agents.length === 0) {
    return {};
  }
  const defaults = agents.filter((agent) => agent.default === true);
  if (defaults.length !== 1 || typeof defaults[0]?.id !== "string") {
    return {
      warning:
        "Skipped legacy main-session key migration because the roster has no unique explicit default.",
    };
  }
  const defaultAgentId = normalizeAgentId(defaults[0].id);
  if (
    defaultAgentId === LEGACY_IMPLICIT_AGENT_ID ||
    agents.some((agent) => normalizeAgentId(agent.id) === LEGACY_IMPLICIT_AGENT_ID)
  ) {
    return {};
  }
  return { defaultAgentId, mainKey: normalizeMainKey(cfg.session?.mainKey) };
}

function resolveMigrationCacheKey(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string {
  const roster = resolveMigrationRoster(cfg);
  return JSON.stringify([
    "defaultAgentId" in roster ? roster.defaultAgentId : null,
    "mainKey" in roster ? roster.mainKey : null,
    cfg.session?.store ?? null,
    env.OPENCLAW_STATE_DIR ?? null,
    env.HOME ?? null,
  ]);
}

function collisionWarning(canonicalKey: string, sourcePath: string): string {
  return `Kept existing ${canonicalKey}; legacy main-session row remains in ${sourcePath}.`;
}

async function removeCopiedLegacyRows(params: {
  entry: NonNullable<ReturnType<typeof loadExactSqliteSessionEntry>>["entry"];
  legacyKeys: string[];
  sourceKey: string;
  storePath: string;
}): Promise<string | undefined> {
  try {
    await deleteSqliteSessionEntryLifecycle({
      agentId: LEGACY_IMPLICIT_AGENT_ID,
      archiveTranscript: false,
      expectedEntry: params.entry,
      storePath: params.storePath,
      target: { canonicalKey: params.sourceKey, storeKeys: params.legacyKeys },
    });
    return undefined;
  } catch (error) {
    return `Copied the legacy main session but could not remove its old key from ${params.storePath}: ${String(error)}`;
  }
}

/** Migrates shipped implicit-main keys into the configured non-main default's store. */
export async function migrateLegacyDefaultMainSessionKeys(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyMainSessionKeyMigrationResult> {
  const roster = resolveMigrationRoster(cfg);
  if (!("defaultAgentId" in roster)) {
    return { changes: [], warnings: roster.warning ? [roster.warning] : [] };
  }

  const { defaultAgentId, mainKey } = roster;
  const canonicalKey = `agent:${defaultAgentId}:${mainKey}`;
  const legacyKeys = [...new Set([`agent:main:${mainKey}`, "agent:main:main"])];
  const configuredStore = cfg.session?.store?.trim();
  const defaultStorePath = resolveStorePath(configuredStore, { agentId: defaultAgentId, env });
  const legacyMainStorePath = resolveStorePath(configuredStore, {
    agentId: LEGACY_IMPLICIT_AGENT_ID,
    env,
  });
  const defaultSqlitePath = resolveSqliteTargetFromSessionStorePath(defaultStorePath, {
    agentId: defaultAgentId,
  }).path;
  const legacyMainSqlitePath = resolveSqliteTargetFromSessionStorePath(legacyMainStorePath, {
    agentId: LEGACY_IMPLICIT_AGENT_ID,
  }).path;
  const changes: string[] = [];
  const warnings: string[] = [];

  if (fs.existsSync(defaultSqlitePath)) {
    const outcome = await migrateSqliteSessionEntryKeys({
      agentId: defaultAgentId,
      storePath: defaultStorePath,
      canonicalKey,
      legacyKeys,
    });
    if (outcome.status === "migrated") {
      changes.push(`Migrated legacy main-session key to ${canonicalKey}.`);
    } else if (outcome.status === "canonical-exists") {
      warnings.push(collisionWarning(canonicalKey, defaultStorePath));
    } else if (outcome.status === "aliases-disagree") {
      warnings.push("Skipped legacy main-session key migration because its aliases disagree.");
    } else if (outcome.status === "legacy-present") {
      throw new Error("Unexpected dry-run session migration outcome.");
    }
  }

  if (legacyMainSqlitePath === defaultSqlitePath || !fs.existsSync(legacyMainSqlitePath)) {
    return { changes, warnings };
  }

  const sourceEntries = legacyKeys.flatMap((sessionKey) => {
    const found = loadExactSqliteSessionEntry({
      agentId: LEGACY_IMPLICIT_AGENT_ID,
      sessionKey,
      storePath: legacyMainStorePath,
    });
    return found ? [found] : [];
  });
  if (sourceEntries.length === 0) {
    return { changes, warnings };
  }
  if (new Set(sourceEntries.map(({ entry }) => entry.sessionId)).size > 1) {
    warnings.push("Skipped legacy main-store session migration because its aliases disagree.");
    return { changes, warnings };
  }
  const source = sourceEntries.toSorted(
    (left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0),
  )[0]!;
  const existing = loadExactSqliteSessionEntry({
    agentId: defaultAgentId,
    sessionKey: canonicalKey,
    storePath: defaultStorePath,
  });
  if (existing) {
    if (existing.entry.sessionId === source.entry.sessionId) {
      const cleanupWarning = await removeCopiedLegacyRows({
        entry: source.entry,
        legacyKeys: sourceEntries.map(({ sessionKey }) => sessionKey),
        sourceKey: source.sessionKey,
        storePath: legacyMainStorePath,
      });
      if (cleanupWarning) {
        warnings.push(cleanupWarning);
      }
    } else {
      warnings.push(collisionWarning(canonicalKey, legacyMainStorePath));
    }
    return { changes, warnings };
  }

  const transcriptEvents = loadSqliteTranscriptEventsSync({
    agentId: LEGACY_IMPLICIT_AGENT_ID,
    sessionId: source.entry.sessionId,
    storePath: legacyMainStorePath,
  });
  const imported = await importSqliteSessionRows({
    agentId: defaultAgentId,
    entry: source.entry,
    sessionKey: canonicalKey,
    skipIfExists: true,
    storePath: defaultStorePath,
    readTranscriptEvents: (append) => {
      for (const event of transcriptEvents) {
        append(event);
      }
    },
  });
  if (!imported.imported) {
    warnings.push(collisionWarning(canonicalKey, legacyMainStorePath));
    return { changes, warnings };
  }

  const cleanupWarning = await removeCopiedLegacyRows({
    entry: source.entry,
    legacyKeys: sourceEntries.map(({ sessionKey }) => sessionKey),
    sourceKey: source.sessionKey,
    storePath: legacyMainStorePath,
  });
  if (cleanupWarning) {
    warnings.push(cleanupWarning);
  }
  changes.push(`Migrated legacy main-session key from ${legacyMainStorePath} to ${canonicalKey}.`);
  return { changes, warnings };
}

/** Runs the automatic upgrade once per relevant runtime config before session access. */
export function ensureLegacyDefaultMainSessionKeysMigrated(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyMainSessionKeyMigrationResult> {
  const key = resolveMigrationCacheKey(cfg, env);
  if (pendingMigration?.key === key) {
    return pendingMigration.settled
      ? Promise.resolve({ changes: [], warnings: [] })
      : pendingMigration.promise;
  }
  const promise = migrateLegacyDefaultMainSessionKeys(cfg, env)
    .then((result) => {
      if (pendingMigration?.promise === promise) {
        pendingMigration.settled = true;
      }
      return result;
    })
    .catch((error: unknown) => {
      if (pendingMigration?.promise === promise) {
        pendingMigration = undefined;
      }
      throw error;
    });
  pendingMigration = { key, promise, settled: false };
  return promise;
}

export function resetLegacyDefaultMainSessionKeyMigrationForTest(): void {
  pendingMigration = undefined;
}

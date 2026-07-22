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
import type { SessionEntry } from "./types.js";

const LEGACY_AGENT_ID = "main";

export type LegacyMainSessionClaim = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

type OutcomeBase = {
  canonicalKey: string;
  defaultAgentId: string;
  targetStorePath: string;
};

export type LegacyMainSessionKeyMigrationOutcome =
  | ({
      kind: "not-needed";
      resolved: true;
      reason: "no-target" | "no-legacy-rows";
    } & Partial<OutcomeBase>)
  | ({ kind: "migrated"; resolved: true; source: LegacyMainSessionClaim } & OutcomeBase)
  | ({
      kind: "canonical-exists-identical";
      resolved: true;
      canonical: LegacyMainSessionClaim;
      aliases: LegacyMainSessionClaim[];
    } & OutcomeBase)
  | ({
      kind: "canonical-exists-different";
      resolved: false;
      canonical: LegacyMainSessionClaim;
      aliases: LegacyMainSessionClaim[];
    } & OutcomeBase)
  | ({ kind: "aliases-disagree"; resolved: false; aliases: LegacyMainSessionClaim[] } & OutcomeBase)
  | ({
      kind: "store-unreadable";
      resolved: false;
      error: string;
      legacyKeys: string[];
      sourceAgentId: string;
      sourceStorePath: string;
    } & OutcomeBase);

export type LegacyMainSessionKeyMigrationResult = {
  outcomes: LegacyMainSessionKeyMigrationOutcome[];
};

type LoadedClaim = { claim: LegacyMainSessionClaim; entry: SessionEntry };
type UnresolvedOutcome = Extract<LegacyMainSessionKeyMigrationOutcome, { resolved: false }>;

function resolveTarget(cfg: OpenClawConfig) {
  const roster = cfg.agents?.list ?? [];
  const defaults = roster.filter((entry) => entry.default === true);
  if (defaults.length !== 1 || typeof defaults[0]?.id !== "string") {
    return undefined;
  }
  const defaultAgentId = normalizeAgentId(defaults[0].id);
  if (
    defaultAgentId === LEGACY_AGENT_ID ||
    roster.some((entry) => normalizeAgentId(entry.id) === LEGACY_AGENT_ID)
  ) {
    return undefined;
  }
  return { defaultAgentId, mainKey: normalizeMainKey(cfg.session?.mainKey) };
}

function loadClaims(params: {
  agentId: string;
  legacyKeys: string[];
  storePath: string;
}): LoadedClaim[] {
  return params.legacyKeys.flatMap((sessionKey) => {
    const found = loadExactSqliteSessionEntry({
      agentId: params.agentId,
      sessionKey,
      storePath: params.storePath,
    });
    return found
      ? [
          {
            claim: {
              agentId: params.agentId,
              sessionId: found.entry.sessionId,
              sessionKey,
              storePath: params.storePath,
            },
            entry: found.entry,
          },
        ]
      : [];
  });
}

function unreadable(params: {
  base: OutcomeBase;
  error: unknown;
  legacyKeys: string[];
  sourceAgentId: string;
  sourceStorePath: string;
}): UnresolvedOutcome {
  return {
    ...params.base,
    kind: "store-unreadable",
    resolved: false,
    error: String(params.error),
    legacyKeys: params.legacyKeys,
    sourceAgentId: params.sourceAgentId,
    sourceStorePath: params.sourceStorePath,
  };
}

async function removeAliases(params: {
  aliases: LoadedClaim[];
  source: LoadedClaim;
}): Promise<string | undefined> {
  try {
    await deleteSqliteSessionEntryLifecycle({
      agentId: params.source.claim.agentId,
      archiveTranscript: false,
      expectedEntry: params.source.entry,
      storePath: params.source.claim.storePath,
      target: {
        canonicalKey: params.source.claim.sessionKey,
        storeKeys: params.aliases.map((alias) => alias.claim.sessionKey),
      },
    });
    return undefined;
  } catch (error) {
    return String(error);
  }
}

async function migrateSource(params: {
  base: OutcomeBase;
  defaultAgentId: string;
  legacyKeys: string[];
  sourceAgentId: string;
  sourceStorePath: string;
}): Promise<LegacyMainSessionKeyMigrationOutcome> {
  let aliases: LoadedClaim[];
  try {
    aliases = loadClaims({
      agentId: params.sourceAgentId,
      legacyKeys: params.legacyKeys,
      storePath: params.sourceStorePath,
    });
  } catch (error) {
    return unreadable({ ...params, error });
  }
  if (aliases.length === 0) {
    return { ...params.base, kind: "not-needed", resolved: true, reason: "no-legacy-rows" };
  }
  if (new Set(aliases.map((alias) => alias.claim.sessionId)).size > 1) {
    return {
      ...params.base,
      kind: "aliases-disagree",
      resolved: false,
      aliases: aliases.map((alias) => alias.claim),
    };
  }
  const source = aliases.toSorted(
    (left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0),
  )[0]!;
  let canonical: ReturnType<typeof loadExactSqliteSessionEntry>;
  try {
    canonical = loadExactSqliteSessionEntry({
      agentId: params.defaultAgentId,
      sessionKey: params.base.canonicalKey,
      storePath: params.base.targetStorePath,
    });
  } catch (error) {
    return unreadable({ ...params, error });
  }
  if (canonical) {
    const canonicalClaim = {
      agentId: params.defaultAgentId,
      sessionId: canonical.entry.sessionId,
      sessionKey: params.base.canonicalKey,
      storePath: params.base.targetStorePath,
    };
    if (canonical.entry.sessionId !== source.entry.sessionId) {
      return {
        ...params.base,
        kind: "canonical-exists-different",
        resolved: false,
        canonical: canonicalClaim,
        aliases: aliases.map((alias) => alias.claim),
      };
    }
    const cleanupError = await removeAliases({ aliases, source });
    return cleanupError
      ? unreadable({ ...params, error: cleanupError })
      : {
          ...params.base,
          kind: "canonical-exists-identical",
          resolved: true,
          canonical: canonicalClaim,
          aliases: aliases.map((alias) => alias.claim),
        };
  }

  try {
    if (params.sourceStorePath === params.base.targetStorePath) {
      const result = await migrateSqliteSessionEntryKeys({
        agentId: params.defaultAgentId,
        storePath: params.base.targetStorePath,
        canonicalKey: params.base.canonicalKey,
        legacyKeys: params.legacyKeys,
      });
      if (result.status !== "migrated") {
        return await migrateSource(params);
      }
    } else {
      const transcript = loadSqliteTranscriptEventsSync({
        agentId: params.sourceAgentId,
        sessionId: source.entry.sessionId,
        storePath: params.sourceStorePath,
      });
      const imported = await importSqliteSessionRows({
        agentId: params.defaultAgentId,
        entry: source.entry,
        sessionKey: params.base.canonicalKey,
        skipIfExists: true,
        storePath: params.base.targetStorePath,
        readTranscriptEvents: (append) => transcript.forEach(append),
      });
      if (!imported.imported) {
        return await migrateSource(params);
      }
      const cleanupError = await removeAliases({ aliases, source });
      if (cleanupError) {
        return unreadable({ ...params, error: cleanupError });
      }
    }
    return { ...params.base, kind: "migrated", resolved: true, source: source.claim };
  } catch (error) {
    return unreadable({ ...params, error });
  }
}

/** Doctor/literal-main migration for shipped hardcoded main-session keys. */
export async function migrateLegacyDefaultMainSessionKeys(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyMainSessionKeyMigrationResult> {
  const target = resolveTarget(cfg);
  if (!target) {
    return { outcomes: [{ kind: "not-needed", resolved: true, reason: "no-target" }] };
  }
  const configuredStore = cfg.session?.store?.trim();
  const targetStorePath = resolveStorePath(configuredStore, {
    agentId: target.defaultAgentId,
    env,
  });
  const legacyStorePath = resolveStorePath(configuredStore, { agentId: LEGACY_AGENT_ID, env });
  const targetSqlitePath = resolveSqliteTargetFromSessionStorePath(targetStorePath, {
    agentId: target.defaultAgentId,
  }).path;
  const legacySqlitePath = resolveSqliteTargetFromSessionStorePath(legacyStorePath, {
    agentId: LEGACY_AGENT_ID,
  }).path;
  const base = {
    canonicalKey: `agent:${target.defaultAgentId}:${target.mainKey}`,
    defaultAgentId: target.defaultAgentId,
    targetStorePath,
  };
  const legacyKeys = [...new Set([`agent:main:${target.mainKey}`, "agent:main:main"])];
  const sources = [
    ...(fs.existsSync(targetSqlitePath)
      ? [{ sourceAgentId: target.defaultAgentId, sourceStorePath: targetStorePath }]
      : []),
    ...(legacySqlitePath !== targetSqlitePath && fs.existsSync(legacySqlitePath)
      ? [{ sourceAgentId: LEGACY_AGENT_ID, sourceStorePath: legacyStorePath }]
      : []),
  ];
  if (sources.length === 0) {
    return {
      outcomes: [{ ...base, kind: "not-needed", resolved: true, reason: "no-legacy-rows" }],
    };
  }
  const outcomes: LegacyMainSessionKeyMigrationOutcome[] = [];
  for (const source of sources) {
    outcomes.push(
      await migrateSource({ ...source, base, defaultAgentId: target.defaultAgentId, legacyKeys }),
    );
  }
  return { outcomes };
}

export function isLegacyMainSessionMigrationUnresolved(
  outcome: LegacyMainSessionKeyMigrationOutcome,
): outcome is UnresolvedOutcome {
  return !outcome.resolved;
}

export function formatLegacyMainSessionMigrationOutcome(
  outcome: LegacyMainSessionKeyMigrationOutcome,
): string | undefined {
  if (outcome.kind === "not-needed") {
    return undefined;
  }
  if (outcome.kind === "migrated") {
    return `Migrated ${outcome.source.sessionKey} from ${outcome.source.storePath} to ${outcome.canonicalKey}.`;
  }
  if (outcome.kind === "canonical-exists-identical") {
    return `Removed duplicate ${outcome.aliases.map((alias) => alias.sessionKey).join(", ")} after confirming session ${outcome.canonical.sessionId} at ${outcome.canonicalKey}.`;
  }
  if (outcome.kind === "canonical-exists-different") {
    return `Sessions ${outcome.canonical.sessionId} (${outcome.canonicalKey} in ${outcome.canonical.storePath}) and ${outcome.aliases.map((alias) => `${alias.sessionId} (${alias.sessionKey} in ${alias.storePath})`).join(", ")} both claim main.`;
  }
  if (outcome.kind === "aliases-disagree") {
    return `Legacy main aliases diverge: ${outcome.aliases.map((alias) => `${alias.sessionId} (${alias.sessionKey} in ${alias.storePath})`).join(", ")}.`;
  }
  return `Could not read legacy main-session store ${outcome.sourceStorePath}: ${outcome.error}`;
}

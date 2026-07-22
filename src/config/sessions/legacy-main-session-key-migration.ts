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

type UnresolvedOutcome = Extract<LegacyMainSessionKeyMigrationOutcome, { resolved: false }>;

function resolveTarget(
  cfg: OpenClawConfig,
): { defaultAgentId: string; mainKey: string } | undefined {
  const agents = cfg.agents?.list ?? [];
  const defaults = agents.filter((agent) => agent.default === true);
  if (defaults.length !== 1 || typeof defaults[0]?.id !== "string") {
    return undefined;
  }
  const defaultAgentId = normalizeAgentId(defaults[0].id);
  if (
    defaultAgentId === LEGACY_AGENT_ID ||
    agents.some((agent) => normalizeAgentId(agent.id) === LEGACY_AGENT_ID)
  ) {
    return undefined;
  }
  return { defaultAgentId, mainKey: normalizeMainKey(cfg.session?.mainKey) };
}

function claim(params: {
  agentId: string;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): LegacyMainSessionClaim {
  return {
    agentId: params.agentId,
    sessionId: params.entry.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
}

function loadClaims(params: {
  agentId: string;
  legacyKeys: string[];
  storePath: string;
}): Array<{ claim: LegacyMainSessionClaim; entry: SessionEntry }> {
  return params.legacyKeys.flatMap((sessionKey) => {
    const found = loadExactSqliteSessionEntry({
      agentId: params.agentId,
      sessionKey,
      storePath: params.storePath,
    });
    return found
      ? [
          {
            claim: claim({
              agentId: params.agentId,
              entry: found.entry,
              sessionKey,
              storePath: params.storePath,
            }),
            entry: found.entry,
          },
        ]
      : [];
  });
}

async function removeAliases(params: {
  aliases: Array<{ claim: LegacyMainSessionClaim; entry: SessionEntry }>;
  source: { claim: LegacyMainSessionClaim; entry: SessionEntry };
}): Promise<string | undefined> {
  try {
    await deleteSqliteSessionEntryLifecycle({
      agentId: params.source.claim.agentId,
      archiveTranscript: false,
      expectedEntry: params.source.entry,
      storePath: params.source.claim.storePath,
      target: {
        canonicalKey: params.source.claim.sessionKey,
        storeKeys: params.aliases.map(({ claim: item }) => item.sessionKey),
      },
    });
    return undefined;
  } catch (error) {
    return String(error);
  }
}

function selectSource(aliases: Array<{ claim: LegacyMainSessionClaim; entry: SessionEntry }>): {
  claim: LegacyMainSessionClaim;
  entry: SessionEntry;
} {
  return aliases.toSorted(
    (left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0),
  )[0]!;
}

async function classifyCanonical(params: {
  aliases: Array<{ claim: LegacyMainSessionClaim; entry: SessionEntry }>;
  base: OutcomeBase;
  canonical: { claim: LegacyMainSessionClaim; entry: SessionEntry };
}): Promise<LegacyMainSessionKeyMigrationOutcome> {
  const identical = params.aliases.every(
    ({ claim: item }) => item.sessionId === params.canonical.claim.sessionId,
  );
  if (!identical) {
    return {
      ...params.base,
      kind: "canonical-exists-different",
      resolved: false,
      canonical: params.canonical.claim,
      aliases: params.aliases.map(({ claim: item }) => item),
    };
  }
  const cleanupError = await removeAliases({ aliases: params.aliases, source: params.aliases[0]! });
  return cleanupError
    ? {
        ...params.base,
        kind: "store-unreadable",
        resolved: false,
        error: cleanupError,
        legacyKeys: params.aliases.map(({ claim: item }) => item.sessionKey),
        sourceAgentId: params.aliases[0]!.claim.agentId,
        sourceStorePath: params.aliases[0]!.claim.storePath,
      }
    : {
        ...params.base,
        kind: "canonical-exists-identical",
        resolved: true,
        canonical: params.canonical.claim,
        aliases: params.aliases.map(({ claim: item }) => item),
      };
}

function unreadableOutcome(params: {
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

async function migrateFromStore(params: {
  base: OutcomeBase;
  defaultAgentId: string;
  legacyKeys: string[];
  sourceAgentId: string;
  sourceStorePath: string;
}): Promise<LegacyMainSessionKeyMigrationOutcome> {
  let aliases: ReturnType<typeof loadClaims>;
  try {
    aliases = loadClaims({
      agentId: params.sourceAgentId,
      legacyKeys: params.legacyKeys,
      storePath: params.sourceStorePath,
    });
  } catch (error) {
    return unreadableOutcome({ ...params, error });
  }
  if (aliases.length === 0) {
    return { ...params.base, kind: "not-needed", resolved: true, reason: "no-legacy-rows" };
  }
  const source = selectSource(aliases);
  const aliasesDisagree = new Set(aliases.map(({ claim: item }) => item.sessionId)).size > 1;
  let canonicalEntry: ReturnType<typeof loadExactSqliteSessionEntry>;
  try {
    canonicalEntry = loadExactSqliteSessionEntry({
      agentId: params.defaultAgentId,
      sessionKey: params.base.canonicalKey,
      storePath: params.base.targetStorePath,
    });
  } catch (error) {
    return unreadableOutcome({ ...params, error });
  }
  if (canonicalEntry) {
    if (aliasesDisagree && canonicalEntry.entry.sessionId === source.entry.sessionId) {
      return {
        ...params.base,
        kind: "aliases-disagree",
        resolved: false,
        aliases: aliases.map(({ claim: item }) => item),
      };
    }
    return await classifyCanonical({
      aliases,
      base: params.base,
      canonical: {
        claim: claim({
          agentId: params.defaultAgentId,
          entry: canonicalEntry.entry,
          sessionKey: params.base.canonicalKey,
          storePath: params.base.targetStorePath,
        }),
        entry: canonicalEntry.entry,
      },
    });
  }

  if (aliasesDisagree) {
    try {
      const transcriptEvents = loadSqliteTranscriptEventsSync({
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
        readTranscriptEvents: (append) => transcriptEvents.forEach(append),
      });
      if (!imported.imported) {
        return await migrateFromStore(params);
      }
    } catch (error) {
      return unreadableOutcome({ ...params, error });
    }
    return {
      ...params.base,
      kind: "aliases-disagree",
      resolved: false,
      aliases: aliases.map(({ claim: item }) => item),
    };
  }

  try {
    if (params.sourceStorePath === params.base.targetStorePath) {
      const migrated = await migrateSqliteSessionEntryKeys({
        agentId: params.defaultAgentId,
        storePath: params.base.targetStorePath,
        canonicalKey: params.base.canonicalKey,
        legacyKeys: aliases.map(({ claim: item }) => item.sessionKey),
      });
      if (migrated.status !== "migrated") {
        return await migrateFromStore(params);
      }
    } else {
      const transcriptEvents = loadSqliteTranscriptEventsSync({
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
        readTranscriptEvents: (append) => transcriptEvents.forEach(append),
      });
      if (!imported.imported) {
        return await migrateFromStore(params);
      }
      const cleanupError = await removeAliases({ aliases, source });
      if (cleanupError) {
        return unreadableOutcome({ ...params, error: cleanupError });
      }
    }
    return { ...params.base, kind: "migrated", resolved: true, source: source.claim };
  } catch (error) {
    return unreadableOutcome({ ...params, error });
  }
}

/** Migrates shipped implicit-main keys into the configured non-main default's store. */
export async function migrateLegacyDefaultMainSessionKeys(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyMainSessionKeyMigrationResult> {
  const target = resolveTarget(cfg);
  if (!target) {
    return { outcomes: [{ kind: "not-needed", resolved: true, reason: "no-target" }] };
  }
  const configuredStore = cfg.session?.store?.trim();
  const canonicalKey = `agent:${target.defaultAgentId}:${target.mainKey}`;
  const legacyKeys = [...new Set([`agent:main:${target.mainKey}`, "agent:main:main"])];
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
  const base = { canonicalKey, defaultAgentId: target.defaultAgentId, targetStorePath };
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
      await migrateFromStore({
        ...source,
        base,
        defaultAgentId: target.defaultAgentId,
        legacyKeys,
      }),
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
    return `Removed duplicate ${outcome.aliases.map((item) => item.sessionKey).join(", ")} after confirming session ${outcome.canonical.sessionId} at ${outcome.canonicalKey}.`;
  }
  if (outcome.kind === "canonical-exists-different") {
    return `Sessions ${outcome.canonical.sessionId} (${outcome.canonicalKey} in ${outcome.canonical.storePath}) and ${outcome.aliases.map((item) => `${item.sessionId} (${item.sessionKey} in ${item.storePath})`).join(", ")} both claim main.`;
  }
  if (outcome.kind === "aliases-disagree") {
    return `Legacy main aliases diverge: ${outcome.aliases.map((item) => `${item.sessionId} (${item.sessionKey} in ${item.storePath})`).join(", ")}.`;
  }
  return `Could not read legacy main-session store ${outcome.sourceStorePath}: ${outcome.error}`;
}

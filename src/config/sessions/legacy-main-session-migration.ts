import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds, tryResolveSoleAgentId } from "../../agents/agent-scope-config.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeAgentId, normalizeMainKey } from "../../routing/session-key.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db-registry.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  readClaimsFromStore,
  storeHasLegacyAgentSessionKey,
} from "./legacy-main-session-key-scan.js";
import {
  claimsMatch,
  processIdenticalClaims,
  repairDivergentClaims,
  samePhysicalStore,
  warningForDivergence,
} from "./legacy-main-session-migration-operations.js";
import type {
  LegacyMainSessionMigrationMode,
  LegacyMainSessionMigrationOutcome,
  LegacyMainSessionMigrationResult,
  PhysicalStore,
  SessionClaim,
} from "./legacy-main-session-migration.contract.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAgentSessionStoreTargetsSync,
  resolveSessionStoreCompatibilityAgentId,
} from "./targets.js";

const SOURCE_KEY = "legacy-main-session-keys";
const MIGRATION_KIND = "legacy-main-session-keys-v1";
const REPORT_VERSION = 1;

type LedgerDatabase = Pick<OpenClawStateKyselyDatabase, "migration_runs" | "migration_sources">;

type ArmingDecision =
  | { armed: false; reason: "legacy-agent-present" | "owner-unresolved" }
  | { armed: true; ownerAgentId: string };

type LedgerReport = {
  version: 1;
  legacyAgentId: string;
  mainKey: string;
  ownerAgentId: string;
  outcomes: LegacyMainSessionMigrationOutcome[];
  sourceLayout: string[];
  status: "complete";
};

function resolveArmingDecision(cfg: OpenClawConfig, legacyAgentId: string): ArmingDecision {
  const roster = new Set(listAgentIds(cfg).map(normalizeAgentId));
  if (roster.has(legacyAgentId)) {
    return { armed: false, reason: "legacy-agent-present" };
  }
  const sole = tryResolveSoleAgentId(cfg);
  if (sole && roster.has(normalizeAgentId(sole))) {
    return { armed: true, ownerAgentId: normalizeAgentId(sole) };
  }
  const sessionStoreOwner = cfg.agents?.defaults?.sessionStore?.agentId?.trim();
  if (sessionStoreOwner) {
    const normalized = normalizeAgentId(sessionStoreOwner);
    if (roster.has(normalized)) {
      return { armed: true, ownerAgentId: normalized };
    }
  }
  return { armed: false, reason: "owner-unresolved" };
}

function addPhysicalStore(stores: PhysicalStore[], candidate: PhysicalStore): void {
  if (!stores.some((store) => samePhysicalStore(store, candidate))) {
    stores.push(candidate);
  }
}

function inspectPath(pathname: string): "missing" | "present" {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  const target = entry.isSymbolicLink() ? fs.statSync(pathname) : entry;
  if (!target.isFile()) {
    throw new Error(`session store is not a regular file: ${pathname}`);
  }
  return "present";
}

function resolveMissingPhysicalPath(pathname: string): string {
  let current = path.resolve(pathname);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(current, ...suffix);
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function resolvePhysicalPathIdentity(pathname: string): string {
  try {
    const stat = fs.statSync(pathname, { bigint: true });
    if (!stat.isFile()) {
      throw new Error(`session store is not a regular file: ${pathname}`);
    }
    return `file:${stat.dev}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return `missing:${resolveMissingPhysicalPath(pathname)}`;
  }
}

type ResolvedPhysicalStores = {
  jsonPaths: string[];
  stores: PhysicalStore[];
  unreadable: LegacyMainSessionMigrationOutcome[];
};

function resolvePhysicalStores(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  legacyAgentId: string;
  mode: LegacyMainSessionMigrationMode;
  ownerAgentId?: string;
}): ResolvedPhysicalStores {
  const logicalTargets = [
    ...resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, { env: params.env }),
    ...resolveAgentSessionStoreTargetsSync(params.cfg, params.legacyAgentId, { env: params.env }),
    {
      agentId: params.legacyAgentId,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.legacyAgentId,
        env: params.env,
      }),
    },
  ];
  if (params.ownerAgentId) {
    logicalTargets.push({
      agentId: params.ownerAgentId,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.ownerAgentId,
        env: params.env,
      }),
    });
  }
  const defaultAgentId = params.ownerAgentId ?? resolveSessionStoreCompatibilityAgentId(params.cfg);
  const stores: PhysicalStore[] = [];
  const jsonPaths = new Set<string>();
  const unreadable: LegacyMainSessionMigrationOutcome[] = [];
  for (const target of logicalTargets) {
    try {
      if (!target.storePath.endsWith(".sqlite") && inspectPath(target.storePath) === "present") {
        jsonPaths.add(path.resolve(target.storePath));
      }
      const resolved = resolveSqliteTargetFromSessionStorePath(target.storePath, {
        agentId: target.agentId,
        defaultAgentId,
        env: params.env,
      });
      const physical: PhysicalStore = {
        databaseAgentId: normalizeAgentId(resolved.agentId ?? target.agentId),
        ownerStorePath: target.storePath,
        path: resolved.path,
      };
      resolvePhysicalPathIdentity(physical.path);
      addPhysicalStore(stores, physical);
    } catch (error) {
      if (params.mode === "doctor-fix") {
        throw new Error(
          `cannot inspect legacy session store ${target.storePath}: ${String(error)}`,
          {
            cause: error,
          },
        );
      }
      unreadable.push({
        kind: "store-unreadable",
        detail: String(error),
        paths: [target.storePath],
      });
    }
  }
  return { jsonPaths: [...jsonPaths], stores, unreadable };
}

function resolveSourceLayout(resolved: ResolvedPhysicalStores): string[] {
  return [
    ...new Set([
      ...resolved.stores.map(
        (store) => `sqlite:${store.databaseAgentId}:${resolvePhysicalPathIdentity(store.path)}`,
      ),
      ...resolved.jsonPaths.map((pathname) => `json:${resolvePhysicalPathIdentity(pathname)}`),
    ]),
  ].toSorted();
}

function readLedger(env: NodeJS.ProcessEnv): { report: LedgerReport; status: string } | undefined {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<LedgerDatabase>(db)
            .selectFrom("migration_sources")
            .select(["report_json", "status"])
            .where("source_key", "=", SOURCE_KEY),
        );
        if (!row) {
          return undefined;
        }
        try {
          const parsed = JSON.parse(row.report_json) as unknown;
          if (
            !isRecord(parsed) ||
            parsed.version !== REPORT_VERSION ||
            typeof parsed.legacyAgentId !== "string" ||
            typeof parsed.mainKey !== "string" ||
            typeof parsed.ownerAgentId !== "string" ||
            !Array.isArray(parsed.outcomes) ||
            !Array.isArray(parsed.sourceLayout) ||
            parsed.sourceLayout.some((entry) => typeof entry !== "string") ||
            parsed.status !== "complete"
          ) {
            return undefined;
          }
          return { report: parsed as LedgerReport, status: row.status };
        } catch {
          return undefined;
        }
      },
      { env },
    ) ?? undefined
  );
}

function ledgerMatches(
  ledger: { report: LedgerReport; status: string } | undefined,
  identity: Omit<LedgerReport, "outcomes" | "status" | "version">,
): ledger is { report: LedgerReport; status: "completed" } {
  return (
    ledger?.status === "completed" &&
    ledger.report.version === REPORT_VERSION &&
    ledger.report.status === "complete" &&
    ledger.report.legacyAgentId === identity.legacyAgentId &&
    ledger.report.ownerAgentId === identity.ownerAgentId &&
    ledger.report.mainKey === identity.mainKey &&
    ledger.report.sourceLayout.length === identity.sourceLayout.length &&
    ledger.report.sourceLayout.every((entry, index) => entry === identity.sourceLayout[index])
  );
}

function writeLedger(params: {
  env: NodeJS.ProcessEnv;
  identity: Omit<LedgerReport, "outcomes" | "status" | "version">;
  now: number;
  outcomes: LegacyMainSessionMigrationOutcome[];
  stateDir: string;
}): void {
  const report: LedgerReport = {
    version: REPORT_VERSION,
    ...params.identity,
    outcomes: params.outcomes,
    status: "complete",
  };
  const reportJson = JSON.stringify(report);
  const identityHash = createHash("sha256").update(JSON.stringify(params.identity)).digest("hex");
  const runId = `${SOURCE_KEY}:${identityHash.slice(0, 24)}`;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<LedgerDatabase>(db);
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("migration_runs")
          .values({
            id: runId,
            started_at: params.now,
            finished_at: params.now,
            status: "completed",
            report_json: reportJson,
          })
          .onConflict((conflict) =>
            conflict.column("id").doUpdateSet({
              finished_at: params.now,
              status: "completed",
              report_json: reportJson,
            }),
          ),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("migration_sources")
          .values({
            source_key: SOURCE_KEY,
            migration_kind: MIGRATION_KIND,
            source_path: params.stateDir,
            target_table: "session_nodes",
            source_sha256: identityHash,
            source_size_bytes: null,
            source_record_count: params.outcomes.length,
            last_run_id: runId,
            status: "completed",
            imported_at: params.now,
            removed_source: 1,
            report_json: reportJson,
          })
          .onConflict((conflict) =>
            conflict.column("source_key").doUpdateSet({
              source_path: params.stateDir,
              source_sha256: identityHash,
              source_record_count: params.outcomes.length,
              last_run_id: runId,
              status: "completed",
              imported_at: params.now,
              removed_source: 1,
              report_json: reportJson,
            }),
          ),
      );
    },
    { env: params.env },
    { operationLabel: "session-migration.legacy-main-ledger" },
  );
}

/** Migrates retired agent-owned session keys without adding runtime read aliases. */
async function migrateLegacyMainSessionKeysInternal(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  forceScan?: boolean;
  legacyAgentId?: string;
  mode: LegacyMainSessionMigrationMode;
  now?: () => number;
}): Promise<LegacyMainSessionMigrationResult> {
  const env = params.env ?? process.env;
  const legacyAgentId = normalizeAgentId(params.legacyAgentId ?? "main");
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const arming = resolveArmingDecision(params.cfg, legacyAgentId);
  const base = {
    changes: [] as string[],
    legacyAgentId,
    mainKey,
    warnings: [] as string[],
  };
  if (!arming.armed) {
    if (arming.reason === "owner-unresolved") {
      // Owner guidance is useful only when legacy rows may exist; unreadable or JSON
      // candidates fail open because they cannot prove the fleet is clean.
      let rowsMayExist: boolean;
      try {
        const resolved = resolvePhysicalStores({
          cfg: params.cfg,
          env,
          legacyAgentId,
          mode: params.mode,
        });
        rowsMayExist =
          resolved.unreadable.length > 0 ||
          resolved.jsonPaths.length > 0 ||
          resolved.stores.some(
            (store) =>
              inspectPath(store.path) === "present" &&
              storeHasLegacyAgentSessionKey({ env, legacyAgentId, store }),
          );
      } catch {
        rowsMayExist = true;
      }
      if (!rowsMayExist) {
        return {
          ...base,
          armed: false,
          complete: true,
          ledgerComplete: false,
          outcomes: [{ kind: "no-legacy-rows", detail: "no configured owner" }],
        };
      }
    }
    const unresolved = arming.reason === "owner-unresolved";
    return {
      ...base,
      armed: false,
      complete: false,
      ledgerComplete: false,
      outcomes: [{ kind: "not-armed", detail: arming.reason }],
      warnings: unresolved
        ? [
            `session: legacy ${legacyAgentId} rows have no unambiguous configured owner; preserve them and run openclaw doctor after assigning agents.defaults.sessionStore.agentId`,
          ]
        : [],
    };
  }
  const ownerAgentId = arming.ownerAgentId;
  const resolved = resolvePhysicalStores({
    cfg: params.cfg,
    env,
    legacyAgentId,
    mode: params.mode,
    ownerAgentId,
  });
  const outcomes: LegacyMainSessionMigrationOutcome[] = [
    ...resolved.jsonPaths.map((pathname) => ({
      kind: "legacy-json-store" as const,
      paths: [pathname],
      detail: "Doctor must migrate JSON sessions to SQLite before legacy-main key migration",
    })),
    ...resolved.unreadable,
  ];
  const warnings = [...base.warnings];
  for (const unreadable of resolved.unreadable) {
    warnings.push(
      `session: could not inspect ${unreadable.paths?.[0] ?? "session store"}: ${unreadable.detail ?? "unknown error"}`,
    );
  }
  for (const pathname of resolved.jsonPaths) {
    warnings.push(
      `session: deferred legacy-main session migration for JSON store ${pathname}; run openclaw doctor --fix`,
    );
  }
  const identityBase = { legacyAgentId, mainKey, ownerAgentId };
  const identity = { ...identityBase, sourceLayout: resolveSourceLayout(resolved) };
  let matchingCompletedLedger = false;
  if (params.mode !== "doctor-fix" && outcomes.length === 0) {
    try {
      const ledger = readLedger(env);
      if (ledgerMatches(ledger, identity)) {
        matchingCompletedLedger = true;
        if (!params.forceScan) {
          return {
            ...base,
            armed: true,
            complete: true,
            ledgerComplete: true,
            ownerAgentId,
            outcomes: [{ kind: "no-legacy-rows", detail: "matching completed ledger" }],
          };
        }
      }
    } catch (error) {
      return {
        ...base,
        armed: true,
        complete: false,
        ledgerComplete: false,
        ownerAgentId,
        outcomes: [{ kind: "store-unreadable", detail: String(error) }],
        warnings: [`session: could not read the legacy-main migration ledger: ${String(error)}`],
      };
    }
  }

  const allLegacy: SessionClaim[] = [];
  const allCanonical: SessionClaim[] = [];
  for (const store of resolved.stores) {
    try {
      if (inspectPath(store.path) === "missing") {
        continue;
      }
      const claims = readClaimsFromStore({ env, legacyAgentId, ownerAgentId, store });
      allLegacy.push(...claims.legacy);
      allCanonical.push(...claims.canonical);
    } catch (error) {
      if (params.mode === "doctor-fix") {
        throw new Error(`cannot read legacy session store ${store.path}: ${String(error)}`, {
          cause: error,
        });
      }
      outcomes.push({ kind: "store-unreadable", detail: String(error), paths: [store.path] });
      warnings.push(`session: could not inspect ${store.path}: ${String(error)}`);
    }
  }
  const inspectionBlocked = outcomes.some(
    (outcome) => outcome.kind === "legacy-json-store" || outcome.kind === "store-unreadable",
  );
  const operationMode = params.mode === "automatic" && inspectionBlocked ? "detect" : params.mode;

  const destinationLogical = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: ownerAgentId,
    env,
  });
  const destinationResolved = resolveSqliteTargetFromSessionStorePath(destinationLogical, {
    agentId: ownerAgentId,
    defaultAgentId: ownerAgentId,
    env,
  });
  const destination: PhysicalStore = resolved.stores.find((store) =>
    isSameOpenClawAgentDatabasePath(store.path, destinationResolved.path),
  ) ?? {
    databaseAgentId: normalizeAgentId(destinationResolved.agentId ?? ownerAgentId),
    ownerStorePath: destinationLogical,
    path: destinationResolved.path,
  };

  const byCanonical = new Map<string, SessionClaim[]>();
  for (const claim of allLegacy) {
    const claims = byCanonical.get(claim.canonicalKey) ?? [];
    claims.push(claim);
    byCanonical.set(claim.canonicalKey, claims);
  }
  for (const [canonicalKey, aliases] of byCanonical) {
    const canonicalClaims = allCanonical.filter((claim) => claim.key === canonicalKey);
    const destinationCanonical = canonicalClaims.find((claim) =>
      samePhysicalStore(claim.store, destination),
    );
    const foreignCanonical = canonicalClaims.filter(
      (claim) => !samePhysicalStore(claim.store, destination),
    );
    const aliasesIdentical = aliases.every((claim) => claimsMatch(claim, aliases[0]!));
    const canonicalMatches = destinationCanonical
      ? aliases.every((claim) => claimsMatch(claim, destinationCanonical))
      : false;

    if (foreignCanonical.length > 0 || (destinationCanonical && !canonicalMatches)) {
      const divergentClaims = [...canonicalClaims, ...aliases];
      const outcome: LegacyMainSessionMigrationOutcome = {
        kind: "divergent-canonical",
        canonicalKey,
        paths: [...new Set(divergentClaims.map((claim) => claim.store.path))],
        sourceKeys: divergentClaims.map((claim) => claim.key),
      };
      if (params.mode === "doctor-fix") {
        const repaired = await repairDivergentClaims({
          canonicalKey,
          claims: divergentClaims,
          destination,
          ...(destinationCanonical ? { destinationCanonical } : {}),
          env,
          ownerAgentId,
        });
        outcome.quarantinedKeys = repaired.quarantinedKeys;
        if (repaired.resolved) {
          outcome.resolved = true;
        } else {
          warnings.push(warningForDivergence("divergent-canonical", canonicalKey, divergentClaims));
        }
      } else {
        warnings.push(warningForDivergence("divergent-canonical", canonicalKey, divergentClaims));
      }
      outcomes.push(outcome);
      continue;
    }

    if (!aliasesIdentical) {
      const outcome: LegacyMainSessionMigrationOutcome = {
        kind: "divergent-aliases",
        canonicalKey,
        paths: [...new Set(aliases.map((claim) => claim.store.path))],
        sourceKeys: aliases.map((claim) => claim.key),
      };
      if (params.mode === "doctor-fix") {
        const repaired = await repairDivergentClaims({
          canonicalKey,
          claims: aliases,
          destination,
          env,
          ownerAgentId,
        });
        outcome.quarantinedKeys = repaired.quarantinedKeys;
        if (repaired.resolved) {
          outcome.resolved = true;
        } else {
          warnings.push(warningForDivergence("divergent-aliases", canonicalKey, aliases));
        }
      } else {
        warnings.push(warningForDivergence("divergent-aliases", canonicalKey, aliases));
      }
      outcomes.push(outcome);
      continue;
    }

    const outcome = await processIdenticalClaims({
      aliases,
      ...(destinationCanonical ? { canonical: destinationCanonical } : {}),
      canonicalKey,
      destination,
      env,
      mode: operationMode,
    });
    outcomes.push(outcome);
    if (outcome.kind === "divergent-aliases" || outcome.kind === "divergent-canonical") {
      warnings.push(warningForDivergence(outcome.kind, canonicalKey, aliases));
    }
  }

  if (allLegacy.length === 0 && outcomes.length === 0) {
    outcomes.push({ kind: "no-legacy-rows" });
  }
  const blocking = outcomes.some(
    (outcome) =>
      outcome.kind === "legacy-json-store" ||
      outcome.kind === "store-unreadable" ||
      ((outcome.kind === "divergent-aliases" || outcome.kind === "divergent-canonical") &&
        outcome.resolved !== true),
  );
  const complete = !blocking;
  const changes =
    operationMode === "detect"
      ? []
      : outcomes.flatMap((outcome) =>
          outcome.kind === "migrated-in-place" ||
          outcome.kind === "migrated-cross-store" ||
          outcome.kind === "canonical-exists-identical"
            ? [`Migrated legacy ${legacyAgentId} session claim ${outcome.canonicalKey}.`]
            : outcome.quarantinedKeys?.length
              ? [
                  `Quarantined ${outcome.quarantinedKeys.length} legacy ${legacyAgentId} session conflict(s).`,
                ]
              : [],
        );
  if (complete && params.mode !== "detect") {
    writeLedger({
      env,
      identity: { ...identityBase, sourceLayout: resolveSourceLayout(resolved) },
      now: params.now?.() ?? Date.now(),
      outcomes,
      stateDir: resolveStateDir(env),
    });
  }
  return {
    armed: true,
    changes,
    complete,
    ledgerComplete:
      complete && (params.mode !== "detect" || (matchingCompletedLedger && allLegacy.length === 0)),
    legacyAgentId,
    mainKey,
    outcomes,
    ownerAgentId,
    warnings,
  };
}

export async function migrateLegacyMainSessionKeys(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** Bypass the startup ledger shortcut and verify the physical legacy stores. */
  forceScan?: boolean;
  legacyAgentId?: string;
  mode: LegacyMainSessionMigrationMode;
  now?: () => number;
}): Promise<LegacyMainSessionMigrationResult> {
  try {
    return await migrateLegacyMainSessionKeysInternal(params);
  } catch (error) {
    if (params.mode === "doctor-fix") {
      throw error;
    }
    const legacyAgentId = normalizeAgentId(params.legacyAgentId ?? "main");
    const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
    const arming = resolveArmingDecision(params.cfg, legacyAgentId);
    return {
      armed: arming.armed,
      changes: [],
      complete: false,
      ledgerComplete: false,
      legacyAgentId,
      mainKey,
      outcomes: [{ kind: "store-unreadable", detail: String(error) }],
      ...(arming.armed ? { ownerAgentId: arming.ownerAgentId } : {}),
      warnings: [`session: legacy-main session migration deferred: ${String(error)}`],
    };
  }
}

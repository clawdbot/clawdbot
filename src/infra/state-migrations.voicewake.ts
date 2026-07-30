import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FsSafeError, root, type Root } from "@openclaw/fs-safe";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { formatErrorMessage } from "./errors.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  legacyMigrationSourceContentMatches,
  legacyMigrationSourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  resolveLegacyMigrationRelativePath,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";
import { normalizeVoiceWakeRoutingConfig } from "./voicewake-routing.js";

const VOICEWAKE_CONFIG_KEY = "default";
const DEFAULT_VOICEWAKE_TRIGGERS = ["openclaw", "claude", "computer"];
const VOICE_WAKE_SOURCE_MAX_BYTES = 64 * 1024;
const VOICE_WAKE_MIGRATION_LOCK_TIMEOUT_MS = 250;
const VOICE_WAKE_MIGRATION_LOCK_POLL_INTERVAL_MS = 25;
const VOICE_WAKE_DOCTOR_CLAIM_SUFFIX = ".doctor-importing";

type LegacyVoiceWakeImportDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "voicewake_routing_config" | "voicewake_routing_routes" | "voicewake_triggers"
>;

type VoiceWakeMigrationOutcome = { kind: "imported" } | { kind: "kept-sqlite" };

type VoiceWakeSource<Value> = {
  sourcePath: string;
  label: string;
  parse: (raw: string) => Value;
  write: (db: DatabaseSync, value: Value) => VoiceWakeMigrationOutcome;
  importedChange: (value: Value) => string;
  keptSqliteNotice: string;
};

type ClaimedVoiceWakeSource<Value> = {
  source: VoiceWakeSource<Value>;
  snapshot: LegacyMigrationSourceSnapshot;
  value: Value;
};

export function resolveLegacyVoiceWakeTriggersPath(stateDir: string): string {
  return path.join(stateDir, "settings", "voicewake.json");
}

export function resolveLegacyVoiceWakeRoutingPath(stateDir: string): string {
  return path.join(stateDir, "settings", "voicewake-routing.json");
}

function normalizeLegacyVoiceWakeTriggers(input: unknown): string[] {
  const rec = input && typeof input === "object" ? (input as { triggers?: unknown }) : {};
  const triggers = Array.isArray(rec.triggers)
    ? rec.triggers
        .flatMap((entry) => (typeof entry === "string" ? [entry.trim()] : []))
        .filter((entry) => entry.length > 0)
    : [];
  return triggers.length > 0 ? triggers : DEFAULT_VOICEWAKE_TRIGGERS;
}

function legacyVoiceWakeTargetColumns(target: {
  agentId?: string;
  mode?: "current";
  sessionKey?: string;
}): {
  targetAgentId: string | null;
  targetMode: string;
  targetSessionKey: string | null;
} {
  if (target.agentId) {
    return { targetAgentId: target.agentId, targetMode: "agent", targetSessionKey: null };
  }
  if (target.sessionKey) {
    return { targetAgentId: null, targetMode: "session", targetSessionKey: target.sessionKey };
  }
  return { targetAgentId: null, targetMode: "current", targetSessionKey: null };
}

function relativeVoiceWakePath(stateDir: string, filePath: string): string {
  return resolveLegacyMigrationRelativePath(stateDir, filePath, "Voice Wake");
}

function voiceWakeClaimPath(sourcePath: string): string {
  return `${sourcePath}${VOICE_WAKE_DOCTOR_CLAIM_SUFFIX}`;
}

async function readVoiceWakeSourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
  label: string,
): Promise<LegacyMigrationSourceSnapshot> {
  return await readLegacyMigrationSourceSnapshot({
    stateRoot,
    stateDir,
    sourcePath,
    maxBytes: VOICE_WAKE_SOURCE_MAX_BYTES,
    label,
    hashDecodedText: true,
  });
}

async function restoreVoiceWakeClaim<Value>(params: {
  stateRoot: Root;
  stateDir: string;
  claimed: ClaimedVoiceWakeSource<Value>;
}): Promise<void> {
  const claimPath = voiceWakeClaimPath(params.claimed.source.sourcePath);
  const claimRelativePath = relativeVoiceWakePath(params.stateDir, claimPath);
  const sourceRelativePath = relativeVoiceWakePath(
    params.stateDir,
    params.claimed.source.sourcePath,
  );
  if (!(await params.stateRoot.exists(claimRelativePath))) {
    return;
  }
  if (await params.stateRoot.exists(sourceRelativePath)) {
    throw new Error(
      `legacy ${params.claimed.source.label} source was recreated while Doctor held its claim`,
    );
  }
  await params.stateRoot.move(claimRelativePath, sourceRelativePath);
}

async function recoverInterruptedVoiceWakeClaim(
  stateRoot: Root,
  stateDir: string,
  source: VoiceWakeSource<unknown>,
): Promise<void> {
  const claimPath = voiceWakeClaimPath(source.sourcePath);
  const claimRelativePath = relativeVoiceWakePath(stateDir, claimPath);
  const sourceRelativePath = relativeVoiceWakePath(stateDir, source.sourcePath);
  if (!(await stateRoot.exists(claimRelativePath))) {
    return;
  }
  const claim = await readVoiceWakeSourceSnapshot(stateRoot, stateDir, claimPath, source.label);
  if (!(await stateRoot.exists(sourceRelativePath))) {
    await stateRoot.move(claimRelativePath, sourceRelativePath);
    return;
  }
  const current = await readVoiceWakeSourceSnapshot(
    stateRoot,
    stateDir,
    source.sourcePath,
    source.label,
  );
  if (legacyMigrationSourceContentMatches(claim, current)) {
    await stateRoot.remove(claimRelativePath);
    return;
  }
  throw new Error(`interrupted Voice Wake claim conflicts with source: ${source.sourcePath}`);
}

async function claimVoiceWakeSource<Value>(params: {
  stateRoot: Root;
  stateDir: string;
  source: VoiceWakeSource<Value>;
}): Promise<ClaimedVoiceWakeSource<Value> | null> {
  const sourceRelativePath = relativeVoiceWakePath(params.stateDir, params.source.sourcePath);
  if (!(await params.stateRoot.exists(sourceRelativePath))) {
    return null;
  }
  const snapshot = await readVoiceWakeSourceSnapshot(
    params.stateRoot,
    params.stateDir,
    params.source.sourcePath,
    params.source.label,
  );
  const value = params.source.parse(snapshot.raw);
  const claimPath = voiceWakeClaimPath(params.source.sourcePath);
  await params.stateRoot.move(
    sourceRelativePath,
    relativeVoiceWakePath(params.stateDir, claimPath),
  );
  try {
    const claimedSnapshot = await readVoiceWakeSourceSnapshot(
      params.stateRoot,
      params.stateDir,
      claimPath,
      params.source.label,
    );
    if (!legacyMigrationSourceSnapshotsMatch(claimedSnapshot, snapshot)) {
      throw new Error(`legacy ${params.source.label} source changed before Doctor could claim it`);
    }
    return { source: params.source, snapshot, value };
  } catch (error) {
    try {
      await params.stateRoot.move(
        relativeVoiceWakePath(params.stateDir, claimPath),
        sourceRelativePath,
      );
    } catch (restoreError) {
      throw new Error(`${String(error)}; restore failure: ${String(restoreError)}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function archiveVoiceWakeClaim<Value>(params: {
  stateRoot: Root;
  stateDir: string;
  claimed: ClaimedVoiceWakeSource<Value>;
}): Promise<{ archivePath: string; sourceRecreated: boolean }> {
  const { source, snapshot } = params.claimed;
  const claimPath = voiceWakeClaimPath(source.sourcePath);
  const claimRelativePath = relativeVoiceWakePath(params.stateDir, claimPath);
  const current = await readVoiceWakeSourceSnapshot(
    params.stateRoot,
    params.stateDir,
    claimPath,
    source.label,
  );
  if (!legacyMigrationSourceSnapshotsMatch(current, snapshot)) {
    throw new Error(`legacy ${source.label} claim changed after SQLite import`);
  }
  const opened = await params.stateRoot.open(claimRelativePath, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  try {
    await opened.handle.chmod(0o600);
    await opened.handle.sync();
  } finally {
    await opened.handle.close();
  }

  for (let generation = 1; generation <= 1000; generation += 1) {
    const archivePath = `${source.sourcePath}.migrated${generation === 1 ? "" : `.${generation}`}`;
    const archiveRelativePath = relativeVoiceWakePath(params.stateDir, archivePath);
    if (await params.stateRoot.exists(archiveRelativePath)) {
      continue;
    }
    try {
      await params.stateRoot.move(claimRelativePath, archiveRelativePath);
      const archived = await readVoiceWakeSourceSnapshot(
        params.stateRoot,
        params.stateDir,
        archivePath,
        source.label,
      );
      if (!legacyMigrationSourceSnapshotsMatch(archived, snapshot)) {
        throw new Error(`legacy ${source.label} source changed while archiving`);
      }
      return {
        archivePath,
        sourceRecreated: await params.stateRoot.exists(
          relativeVoiceWakePath(params.stateDir, source.sourcePath),
        ),
      };
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "already-exists") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`no free Voice Wake migration archive path for ${source.sourcePath}`);
}

function writeVoiceWakeTriggers(db: DatabaseSync, triggers: string[]): VoiceWakeMigrationOutcome {
  const stateDb = getNodeSqliteKysely<LegacyVoiceWakeImportDatabase>(db);
  const existing = executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("voicewake_triggers")
      .select(["trigger"])
      .where("config_key", "=", VOICEWAKE_CONFIG_KEY)
      .orderBy("position", "asc"),
  ).rows;
  if (existing.length > 0) {
    return { kind: "kept-sqlite" };
  }
  const updatedAtMs = Date.now();
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("voicewake_triggers").values(
      triggers.map((trigger, position) => ({
        config_key: VOICEWAKE_CONFIG_KEY,
        position,
        trigger,
        updated_at_ms: updatedAtMs,
      })),
    ),
  );
  return { kind: "imported" };
}

function writeVoiceWakeRouting(
  db: DatabaseSync,
  routingConfig: NonNullable<ReturnType<typeof normalizeVoiceWakeRoutingConfig>>,
): VoiceWakeMigrationOutcome {
  const stateDb = getNodeSqliteKysely<LegacyVoiceWakeImportDatabase>(db);
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("voicewake_routing_config")
      .select(["config_key"])
      .where("config_key", "=", VOICEWAKE_CONFIG_KEY),
  );
  if (existing) {
    return { kind: "kept-sqlite" };
  }
  const updatedAtMs = Date.now();
  const defaultTarget = legacyVoiceWakeTargetColumns(routingConfig.defaultTarget);
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("voicewake_routing_config").values({
      config_key: VOICEWAKE_CONFIG_KEY,
      version: 1,
      default_target_mode: defaultTarget.targetMode,
      default_target_agent_id: defaultTarget.targetAgentId,
      default_target_session_key: defaultTarget.targetSessionKey,
      updated_at_ms: updatedAtMs,
    }),
  );
  if (routingConfig.routes.length > 0) {
    executeSqliteQuerySync(
      db,
      stateDb.insertInto("voicewake_routing_routes").values(
        routingConfig.routes.map((route, position) => {
          const target = legacyVoiceWakeTargetColumns(route.target);
          return {
            config_key: VOICEWAKE_CONFIG_KEY,
            position,
            trigger: route.trigger,
            target_mode: target.targetMode,
            target_agent_id: target.targetAgentId,
            target_session_key: target.targetSessionKey,
            updated_at_ms: updatedAtMs,
          };
        }),
      ),
    );
  }
  return { kind: "imported" };
}

async function migrateVoiceWakeSource<Value>(params: {
  stateRoot: Root;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  source: VoiceWakeSource<Value>;
  changes: string[];
  warnings: string[];
  notices: string[];
}): Promise<void> {
  let claimed: ClaimedVoiceWakeSource<Value> | null;
  try {
    claimed = await claimVoiceWakeSource({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      source: params.source,
    });
  } catch (error) {
    params.warnings.push(`Failed reading legacy ${params.source.label}: ${String(error)}`);
    return;
  }
  if (!claimed) {
    return;
  }
  const sourceRelativePath = relativeVoiceWakePath(params.stateDir, params.source.sourcePath);
  try {
    if (await params.stateRoot.exists(sourceRelativePath)) {
      throw new Error(`legacy ${params.source.label} source was recreated before SQLite import`);
    }
    const outcome = runOpenClawStateWriteTransaction(
      ({ db }) => params.source.write(db, claimed.value),
      { env: params.env },
    );
    const archived = await archiveVoiceWakeClaim({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      claimed,
    });
    if (outcome.kind === "imported") {
      params.changes.push(params.source.importedChange(claimed.value));
    } else {
      params.notices.push(params.source.keptSqliteNotice);
    }
    params.changes.push(`Archived ${params.source.label} legacy source → ${archived.archivePath}`);
    if (archived.sourceRecreated) {
      params.warnings.push(
        `Legacy ${params.source.label} source was recreated during migration; retained it without overwriting canonical SQLite state: ${params.source.sourcePath}`,
      );
    }
  } catch (error) {
    try {
      await restoreVoiceWakeClaim({
        stateRoot: params.stateRoot,
        stateDir: params.stateDir,
        claimed,
      });
    } catch (restoreError) {
      params.warnings.push(
        `Failed restoring legacy ${params.source.label} claim: ${String(restoreError)}`,
      );
    }
    params.warnings.push(`Failed migrating legacy ${params.source.label}: ${String(error)}`);
  }
}

export function detectLegacyVoiceWake(params: {
  stateDir: string;
}): LegacyStateDetection["voiceWake"] {
  const triggersPath = resolveLegacyVoiceWakeTriggersPath(params.stateDir);
  const routingPath = resolveLegacyVoiceWakeRoutingPath(params.stateDir);
  return {
    triggersPath,
    routingPath,
    hasLegacy:
      legacyMigrationSourceOrClaimMayExist(triggersPath) ||
      legacyMigrationSourceOrClaimMayExist(routingPath),
  };
}

export async function migrateLegacyVoiceWakeSettings(params: {
  detected: LegacyStateDetection["voiceWake"];
  stateDir: string;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const triggersPath = params.detected.triggersPath;
  const routingPath = params.detected.routingPath;
  const sources: VoiceWakeSource<unknown>[] = [
    {
      sourcePath: triggersPath,
      label: "voice wake triggers",
      parse: (raw) => normalizeLegacyVoiceWakeTriggers(JSON.parse(raw)),
      write: (db, value) => writeVoiceWakeTriggers(db, value as string[]),
      importedChange: (value) => {
        const triggers = value as string[];
        return `Migrated ${triggers.length} voice wake ${triggers.length === 1 ? "trigger" : "triggers"} → shared SQLite state`;
      },
      keptSqliteNotice: `Kept canonical shared SQLite voice wake triggers and retired the legacy JSON source: ${triggersPath}`,
    },
    {
      sourcePath: routingPath,
      label: "voice wake routing",
      parse: (raw) => {
        const routingConfig = normalizeVoiceWakeRoutingConfig(JSON.parse(raw));
        if (!routingConfig) {
          throw new Error("legacy voice wake routing is invalid");
        }
        return routingConfig;
      },
      write: (db, value) =>
        writeVoiceWakeRouting(
          db,
          value as NonNullable<ReturnType<typeof normalizeVoiceWakeRoutingConfig>>,
        ),
      importedChange: (value) => {
        const routing = value as NonNullable<ReturnType<typeof normalizeVoiceWakeRoutingConfig>>;
        return `Migrated voice wake routing config with ${routing.routes.length} ${routing.routes.length === 1 ? "route" : "routes"} → shared SQLite state`;
      },
      keptSqliteNotice: `Kept canonical shared SQLite voice wake routing and retired the legacy JSON source: ${routingPath}`,
    },
  ];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: VOICE_WAKE_MIGRATION_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: VOICE_WAKE_MIGRATION_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    const detail =
      error instanceof GatewayLockError
        ? "the Gateway or another SQLite maintenance command owns this state directory"
        : String(error);
    return {
      changes,
      warnings: [
        `Failed migrating legacy Voice Wake state: ${detail}. Stop the Gateway and run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes,
      warnings: [
        "Failed migrating legacy Voice Wake state: exclusive state ownership unavailable.",
      ],
    };
  }
  try {
    const stateRoot = await root(params.stateDir, {
      hardlinks: "reject",
      maxBytes: VOICE_WAKE_SOURCE_MAX_BYTES,
      symlinks: "reject",
    });
    for (const source of sources) {
      try {
        await recoverInterruptedVoiceWakeClaim(stateRoot, params.stateDir, source);
      } catch (error) {
        warnings.push(`Failed recovering legacy ${source.label} claim: ${String(error)}`);
        continue;
      }
      await migrateVoiceWakeSource({
        stateRoot,
        stateDir: params.stateDir,
        env,
        source,
        changes,
        warnings,
        notices,
      });
    }
  } catch (error) {
    warnings.push(`Failed migrating legacy Voice Wake state: ${String(error)}`);
  } finally {
    try {
      await lock.release();
    } catch (error) {
      warnings.push(`Voice Wake migration lock release failed: ${formatErrorMessage(error)}`);
    }
  }
  return { changes, warnings, ...(notices.length > 0 ? { notices } : {}) };
}

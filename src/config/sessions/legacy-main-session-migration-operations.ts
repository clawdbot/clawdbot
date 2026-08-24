import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db-registry.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  LegacyMainSessionMigrationMode,
  LegacyMainSessionMigrationOutcome,
  PhysicalStore,
  SessionClaim,
  TranscriptDigest,
} from "./legacy-main-session-migration.contract.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite-import.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

function projectEntryIdentity(entry: SessionEntry): SessionEntry {
  const projected = structuredClone(entry) as SessionEntry & {
    sessionFile?: unknown;
    transcriptPath?: unknown;
  };
  delete projected.sessionFile;
  delete projected.transcriptPath;
  return projected;
}

function digestTranscriptRows(rows: readonly { eventJson: string }[]): TranscriptDigest {
  let rollingHash = "";
  for (const row of rows) {
    rollingHash = createHash("sha256")
      .update(rollingHash)
      .update("\0")
      .update(row.eventJson)
      .digest("hex");
  }
  return { eventCount: rows.length, rollingHash };
}

export function claimsMatch(left: SessionClaim, right: SessionClaim): boolean {
  return (
    isDeepStrictEqual(projectEntryIdentity(left.entry), projectEntryIdentity(right.entry)) &&
    left.digest.eventCount === right.digest.eventCount &&
    left.digest.rollingHash === right.digest.rollingHash
  );
}

export function readClaim(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  store: PhysicalStore,
  key: string,
  canonicalKey: string,
): SessionClaim | undefined {
  const row = readExactSessionEntryRowForCanonicalRepair(database, key);
  if (!row) {
    return undefined;
  }
  const transcriptRows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select(["created_at", "event_json"])
      .where("session_id", "=", row.entry.sessionId)
      .orderBy("seq", "asc"),
  ).rows.map((event) => ({ createdAt: event.created_at, eventJson: event.event_json }));
  return {
    canonicalKey,
    digest: digestTranscriptRows(transcriptRows),
    entry: row.entry,
    eventRows: transcriptRows,
    key,
    store,
  };
}

export function samePhysicalStore(left: PhysicalStore, right: PhysicalStore): boolean {
  return isSameOpenClawAgentDatabasePath(left.path, right.path);
}

function freshestClaim(claims: readonly SessionClaim[]): SessionClaim {
  return [...claims].toSorted((left, right) => {
    const freshness = (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0);
    return (
      freshness ||
      left.key.localeCompare(right.key) ||
      left.store.path.localeCompare(right.store.path)
    );
  })[0]!;
}

export function warningForDivergence(
  kind: "divergent-aliases" | "divergent-canonical",
  canonicalKey: string,
  claims: readonly SessionClaim[],
): string {
  const claimsText = claims.map((claim) => `${claim.store.path}#${claim.key}`).join(", ");
  return `session: ${kind} for ${canonicalKey}; preserved claims ${claimsText}. Run openclaw doctor --fix to quarantine the losing claims.`;
}

function writeMigratedSessionClaim(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): void {
  writeSessionEntry(database, sessionKey, entry, {
    allowStoredAliases: true,
    previousEntry: null,
  });
  replaceSessionOwnerInTransaction(database, sessionKey, entry.owner);
}

function migrateClaimsInPlace(params: {
  aliases: readonly SessionClaim[];
  canonical?: SessionClaim;
  canonicalKey: string;
  env: NodeJS.ProcessEnv;
  store: PhysicalStore;
  winner: SessionClaim;
}): boolean {
  let committed = false;
  runOpenClawAgentWriteTransaction(
    (database) => {
      const currentAliases = params.aliases.map((claim) =>
        readClaim(database, params.store, claim.key, params.canonicalKey),
      );
      const currentCanonical = params.canonical
        ? readClaim(database, params.store, params.canonicalKey, params.canonicalKey)
        : undefined;
      if (
        currentAliases.some(
          (claim, index) => !claim || !claimsMatch(claim, params.aliases[index]!),
        ) ||
        (params.canonical &&
          (!currentCanonical || !claimsMatch(currentCanonical, params.canonical)))
      ) {
        return;
      }
      if (!currentCanonical) {
        writeMigratedSessionClaim(database, params.canonicalKey, params.winner.entry);
      }
      deleteLegacySessionEntryRows(
        database,
        params.aliases.map((claim) => claim.key),
        params.canonicalKey,
        { rehomeMembers: true },
      );
      committed = true;
    },
    { agentId: params.store.databaseAgentId, env: params.env, path: params.store.path },
    { operationLabel: "session-migration.legacy-main-in-place" },
  );
  return committed;
}

async function copyClaimCrossStore(params: {
  canonicalKey: string;
  destination: PhysicalStore;
  env: NodeJS.ProcessEnv;
  source: SessionClaim;
}): Promise<SessionClaim | undefined> {
  await importSqliteSessionRows({
    agentId: params.destination.databaseAgentId,
    env: params.env,
    storePath: params.destination.path,
    sessionKey: params.canonicalKey,
    entry: params.source.entry,
    skipIfExists: true,
    readExactTranscriptRows: (append) => {
      for (const row of params.source.eventRows) {
        append(row);
      }
    },
  });
  const destination = withOpenClawAgentDatabaseReadOnly(
    (database) => readClaim(database, params.destination, params.canonicalKey, params.canonicalKey),
    {
      agentId: params.destination.databaseAgentId,
      env: params.env,
      path: params.destination.path,
    },
  );
  return destination.found ? destination.value : undefined;
}

async function deleteExpectedClaim(claim: SessionClaim): Promise<boolean> {
  const result = await deleteSessionEntryLifecycle({
    agentId: parseAgentSessionKey(claim.key)?.agentId,
    archiveTranscript: false,
    deleteTranscriptWithoutArchive: true,
    expectedEntry: claim.entry,
    expectedTranscript: {
      sessionId: claim.entry.sessionId,
      eventJson: claim.eventRows.map((row) => row.eventJson),
    },
    requireWriteSuccess: true,
    storePath: claim.store.path,
    target: { canonicalKey: claim.key, storeKeys: [claim.key] },
  });
  return result.deleted;
}

function quarantineClaim(params: {
  claim: SessionClaim;
  env: NodeJS.ProcessEnv;
  ownerAgentId: string;
}): string | undefined {
  let quarantineKey: string | undefined;
  runOpenClawAgentWriteTransaction(
    (database) => {
      const fresh = readClaim(
        database,
        params.claim.store,
        params.claim.key,
        params.claim.canonicalKey,
      );
      if (!fresh || !claimsMatch(fresh, params.claim)) {
        return;
      }
      for (let index = 1; ; index += 1) {
        const candidate = `agent:${params.ownerAgentId}:legacy-main-conflict-${index}`;
        if (!readExactSessionEntryRow(database, candidate)) {
          quarantineKey = candidate;
          break;
        }
      }
      writeMigratedSessionClaim(database, quarantineKey, params.claim.entry);
      deleteLegacySessionEntryRows(database, [params.claim.key], quarantineKey, {
        rehomeMembers: true,
      });
    },
    {
      agentId: params.claim.store.databaseAgentId,
      env: params.env,
      path: params.claim.store.path,
    },
    { operationLabel: "session-migration.legacy-main-quarantine" },
  );
  return quarantineKey;
}

export async function processIdenticalClaims(params: {
  aliases: SessionClaim[];
  canonical?: SessionClaim;
  canonicalKey: string;
  destination: PhysicalStore;
  env: NodeJS.ProcessEnv;
  mode: LegacyMainSessionMigrationMode;
}): Promise<LegacyMainSessionMigrationOutcome> {
  const winner = params.canonical ?? freshestClaim(params.aliases);
  const crossStore = params.aliases.some(
    (claim) => !samePhysicalStore(claim.store, params.destination),
  );
  if (params.mode === "detect") {
    return {
      kind: params.canonical
        ? "canonical-exists-identical"
        : crossStore
          ? "migrated-cross-store"
          : "migrated-in-place",
      canonicalKey: params.canonicalKey,
      paths: [...new Set(params.aliases.map((claim) => claim.store.path))],
      sourceKeys: params.aliases.map((claim) => claim.key),
    };
  }

  let canonical = params.canonical;
  const destinationAliases = params.aliases.filter((claim) =>
    samePhysicalStore(claim.store, params.destination),
  );
  if (!canonical && destinationAliases.length > 0) {
    const inPlaceWinner = freshestClaim(destinationAliases);
    if (
      !migrateClaimsInPlace({
        aliases: destinationAliases,
        canonicalKey: params.canonicalKey,
        env: params.env,
        store: params.destination,
        winner: inPlaceWinner,
      })
    ) {
      return {
        kind: "divergent-aliases",
        canonicalKey: params.canonicalKey,
        detail: "source aliases changed during the in-place transaction",
      };
    }
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        readClaim(database, params.destination, params.canonicalKey, params.canonicalKey),
      {
        agentId: params.destination.databaseAgentId,
        env: params.env,
        path: params.destination.path,
      },
    );
    canonical = result.found ? result.value : undefined;
  }
  if (!canonical) {
    const sourceBefore = winner;
    const copied = await copyClaimCrossStore({
      canonicalKey: params.canonicalKey,
      destination: params.destination,
      env: params.env,
      source: sourceBefore,
    });
    const sourceAfter = withOpenClawAgentDatabaseReadOnly(
      (database) => readClaim(database, sourceBefore.store, sourceBefore.key, params.canonicalKey),
      {
        agentId: sourceBefore.store.databaseAgentId,
        env: params.env,
        path: sourceBefore.store.path,
      },
    );
    if (
      !copied ||
      !claimsMatch(copied, sourceBefore) ||
      !sourceAfter.found ||
      !sourceAfter.value ||
      !claimsMatch(sourceAfter.value, sourceBefore)
    ) {
      return {
        kind: "divergent-canonical",
        canonicalKey: params.canonicalKey,
        detail: "source or imported canonical changed during cross-store copy verification",
      };
    }
    canonical = copied;
  }
  if (!claimsMatch(canonical, winner)) {
    return {
      kind: "divergent-canonical",
      canonicalKey: params.canonicalKey,
      detail: "canonical content differs from the legacy claim",
    };
  }

  // The destination commit is durable before source cleanup. Every retry therefore sees either
  // the original claim, an identical canonical claim, or both; no read-through fallback is needed.
  for (const claim of params.aliases) {
    if (samePhysicalStore(claim.store, params.destination)) {
      continue;
    }
    if (!(await deleteExpectedClaim(claim))) {
      return {
        kind: "divergent-canonical",
        canonicalKey: params.canonicalKey,
        detail: `source changed before expected-entry cleanup: ${claim.store.path}#${claim.key}`,
      };
    }
  }
  if (params.canonical && destinationAliases.length > 0) {
    if (
      !migrateClaimsInPlace({
        aliases: destinationAliases,
        canonical: params.canonical,
        canonicalKey: params.canonicalKey,
        env: params.env,
        store: params.destination,
        winner: params.canonical,
      })
    ) {
      return {
        kind: "divergent-canonical",
        canonicalKey: params.canonicalKey,
        detail: "canonical or aliases changed during in-place cleanup",
      };
    }
  }
  return {
    kind: params.canonical
      ? "canonical-exists-identical"
      : crossStore
        ? "migrated-cross-store"
        : "migrated-in-place",
    canonicalKey: params.canonicalKey,
    paths: [...new Set(params.aliases.map((claim) => claim.store.path))],
    sourceKeys: params.aliases.map((claim) => claim.key),
  };
}

export async function repairDivergentClaims(params: {
  canonicalKey: string;
  claims: SessionClaim[];
  destination: PhysicalStore;
  destinationCanonical?: SessionClaim;
  env: NodeJS.ProcessEnv;
  ownerAgentId: string;
}): Promise<{ quarantinedKeys: string[]; resolved: boolean }> {
  const winner = params.destinationCanonical ?? freshestClaim(params.claims);
  if (!params.destinationCanonical) {
    const migrated = await processIdenticalClaims({
      aliases: [winner],
      canonicalKey: params.canonicalKey,
      destination: params.destination,
      env: params.env,
      mode: "automatic",
    });
    if (migrated.kind === "divergent-aliases" || migrated.kind === "divergent-canonical") {
      return { quarantinedKeys: [], resolved: false };
    }
  }
  const canonicalResult = withOpenClawAgentDatabaseReadOnly(
    (database) => readClaim(database, params.destination, params.canonicalKey, params.canonicalKey),
    {
      agentId: params.destination.databaseAgentId,
      env: params.env,
      path: params.destination.path,
    },
  );
  const canonical = canonicalResult.found ? canonicalResult.value : undefined;
  if (!canonical || !claimsMatch(canonical, winner)) {
    return { quarantinedKeys: [], resolved: false };
  }

  const quarantinedKeys: string[] = [];
  for (const claim of params.claims) {
    if (claim === winner || claim === params.destinationCanonical) {
      continue;
    }
    if (claimsMatch(claim, canonical)) {
      const cleaned = samePhysicalStore(claim.store, params.destination)
        ? migrateClaimsInPlace({
            aliases: [claim],
            canonical,
            canonicalKey: params.canonicalKey,
            env: params.env,
            store: params.destination,
            winner: canonical,
          })
        : await deleteExpectedClaim(claim);
      if (!cleaned) {
        return { quarantinedKeys, resolved: false };
      }
      continue;
    }
    const quarantineKey = quarantineClaim({
      claim,
      env: params.env,
      ownerAgentId: params.ownerAgentId,
    });
    if (!quarantineKey) {
      return { quarantinedKeys, resolved: false };
    }
    quarantinedKeys.push(quarantineKey);
  }
  return { quarantinedKeys, resolved: true };
}

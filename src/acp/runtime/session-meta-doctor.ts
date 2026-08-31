import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { loadExactSessionEntryReadOnlyResult } from "../../config/sessions/session-accessor.sqlite-entry-availability.js";
import { readExactSessionEntryRowValidated } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { PluginDoctorRepairAuthority } from "../../infra/state-migrations.types.js";
import type {
  PluginDoctorAcpSessionClaim,
  PluginDoctorStateMigrationContext,
} from "../../plugins/doctor-contract-module.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  acpSessionRowMatchesEntry,
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  parseAcpDatabaseSessionKeyCandidates,
  selectAcpSessionRow,
} from "./session-meta-keys.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";
import { rowToAcpSessionMeta } from "./session-meta.js";

type DoctorAcpScope = { config: OpenClawConfig; env: NodeJS.ProcessEnv; pluginId: string };

// Canonical metadata plus a current binding proves free harness namespaces. Configured
// binding keys still belong to the roster, even when their metadata survives retirement.
function isRetiredClaimOwner(
  config: OpenClawConfig,
  target: { agentId: string; sessionKey: string },
): boolean {
  const parsed = parseAgentSessionKey(target.sessionKey);
  const freeAcp = parsed?.rest.startsWith("acp:") && !parsed.rest.startsWith("acp:binding:");
  return !listAgentIds(config).includes(target.agentId) && !freeAcp;
}

function readClaimBinding(
  scope: DoctorAcpScope,
  target: { agentId: string; sessionKey: string },
): PluginDoctorAcpSessionClaim["binding"] {
  const owner = resolveSessionStorePathForAcp({ cfg: scope.config, env: scope.env, ...target });
  if (isRetiredClaimOwner(scope.config, target)) {
    throw new Error(`retired ACP owner ${owner.agentId}`);
  }
  const resolved = resolveSqliteScope({ ...target, env: scope.env, storePath: owner.storePath });
  const result = loadExactSessionEntryReadOnlyResult({
    ...target,
    sessionKey: resolved.sessionKey,
    env: scope.env,
    storePath: owner.storePath,
  });
  if (!result.found || !result.value) {
    throw new Error(`ACP session binding is ${result.found ? "absent" : result.reason}`);
  }
  const { sessionId, lifecycleRevision, sessionStartedAt } = result.value.entry;
  return { sessionId, lifecycleRevision, sessionStartedAt };
}

export async function inspectAcpSessionClaimsForDoctor(
  scope: DoctorAcpScope,
): Promise<
  Awaited<ReturnType<NonNullable<PluginDoctorStateMigrationContext["inspectAcpSessionClaims"]>>>
> {
  const claims: PluginDoctorAcpSessionClaim[] = [];
  const incomplete: string[] = [];
  try {
    const database = await openExistingOpenClawStateDatabaseReadOnly({ env: scope.env });
    if (!database) {
      return { claims, incomplete };
    }
    try {
      const rows = executeSqliteQuerySync(
        database.db,
        getAcpSessionKysely(database.db)
          .selectFrom("acp_sessions")
          .selectAll()
          .where("backend", "=", scope.pluginId),
      ).rows;
      for (const row of rows) {
        try {
          const target = parseAcpDatabaseSessionKeyCandidates(row.session_key)[0];
          if (
            !target?.agentId ||
            buildAcpDatabaseSessionKey(target.storeSessionKey, target.agentId) !== row.session_key
          ) {
            throw new Error("ACP metadata key is not canonical");
          }
          const claimTarget = { agentId: target.agentId, sessionKey: target.storeSessionKey };
          const binding = readClaimBinding(scope, claimTarget);
          if (row.session_id == null || !acpSessionRowMatchesEntry(row, binding)) {
            throw new Error("ACP metadata binding is absent or stale");
          }
          const meta = rowToAcpSessionMeta(row);
          if (
            (row.identity_json && !meta.identity) ||
            (row.runtime_options_json && !meta.runtimeOptions)
          ) {
            throw new Error("ACP metadata JSON is unreadable");
          }
          claims.push({ ...claimTarget, binding, meta });
        } catch (error) {
          incomplete.push(`${row.session_key}: ${String(error)}`);
        }
      }
    } finally {
      database.walMaintenance.close();
    }
  } catch (error) {
    incomplete.push(String(error));
  }
  return { claims, incomplete };
}

export function updateAcpSessionIdentityForDoctor(
  scope: DoctorAcpScope,
  authority: PluginDoctorRepairAuthority,
  input: Parameters<NonNullable<PluginDoctorStateMigrationContext["updateAcpSessionIdentity"]>>[0],
): void {
  authority.assertCurrent();
  const { claim } = input;
  if (claim.meta.backend !== scope.pluginId || !claim.meta.identity) {
    throw new Error("ACP identity repair requires a matching backend claim and existing identity");
  }
  const key = buildAcpDatabaseSessionKey(claim.sessionKey, claim.agentId);
  const owner = resolveSessionStorePathForAcp({ cfg: scope.config, env: scope.env, ...claim });
  const resolved = resolveSqliteScope({ ...claim, env: scope.env, storePath: owner.storePath });
  const options = toDatabaseOptions(resolved);
  // Open the read handle before the commit section; the maintenance owner excludes
  // writers while the transaction rereads the exact entry binding and ACP row.
  const updated = withOpenClawAgentDatabaseReadOnly((agentDatabase) => {
    runOpenClawStateWriteTransaction(
      (database) => {
        authority.assertOwnedInTransaction(database.db);
        const row = selectAcpSessionRow(database.db, key);
        const entry = readExactSessionEntryRowValidated(agentDatabase, resolved.sessionKey)?.entry;
        const binding = entry && {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          sessionStartedAt: entry.sessionStartedAt,
        };
        if (
          isRetiredClaimOwner(scope.config, claim) ||
          !row ||
          !isDeepStrictEqual(rowToAcpSessionMeta(row), claim.meta) ||
          !isDeepStrictEqual(binding, claim.binding) ||
          !acpSessionRowMatchesEntry(row, claim.binding)
        ) {
          throw new Error(
            "ACP ownership or metadata changed during Doctor repair; source retained",
          );
        }
        executeSqliteQuerySync(
          database.db,
          getAcpSessionKysely(database.db)
            .updateTable("acp_sessions")
            .set({
              runtime_session_name: input.runtimeSessionName,
              identity_json: JSON.stringify({
                ...claim.meta.identity,
                acpxRecordId: input.acpxRecordId,
              }),
            })
            .where("session_key", "=", key),
        );
      },
      { env: scope.env },
    );
  }, options);
  if (!updated.found) {
    throw new Error(`ACP owner database became unavailable: ${updated.reason}`);
  }
}

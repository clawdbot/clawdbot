import {
  rewriteDoctorSessionEntries,
  scanDoctorSessionEntriesTolerant,
} from "../config/sessions/session-accessor.js";
import { stripRuntimeOnlySessionSkillsFields } from "../config/sessions/store-entry-shape.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
} from "../state/openclaw-agent-db.js";
import { runDoctorAgentDatabaseOperation } from "./doctor-agent-database-operation.js";
import { listExistingAgentDatabaseTargets } from "./doctor-session-sqlite-readers.js";

export type SessionResolvedSkillsRepairReport = {
  found: number;
  repaired: number;
  scannedStores: number;
};

/**
 * Strips the runtime-only `resolvedSkills` catalog from existing persisted
 * session rows. New writes already drop it via the shared persistence
 * projection, but rows written before the fix keep the full ~293 KB catalog in
 * every `session_nodes.entry_json` — the reported source of database and heap
 * pressure. Idempotent: a row already stripped is unchanged and skipped.
 */
export function repairCanonicalSessionResolvedSkills(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): SessionResolvedSkillsRepairReport {
  const targets = listExistingAgentDatabaseTargets(params.cfg, params.env);
  let found = 0;
  let repaired = 0;
  for (const target of targets) {
    const sessionKeys: string[] = [];
    const operation = runDoctorAgentDatabaseOperation({
      agentId: target.agentId,
      path: target.sqlitePath,
      run: () => {
        scanDoctorSessionEntriesTolerant(
          { agentId: target.agentId, env: params.env, storePath: target.storePath },
          ({ entry, recoveredFromProjections, sessionKey }) => {
            // Skip rows reconstructed from projections (no entry_json to repair);
            // otherwise strip only when the runtime-only catalog is present.
            if (!recoveredFromProjections && stripRuntimeOnlySessionSkillsFields(entry) !== entry) {
              sessionKeys.push(sessionKey);
            }
          },
        );
        return sessionKeys.length;
      },
    });
    if (!operation.ok) {
      continue;
    }
    found += operation.value;
    if (!params.apply || operation.value === 0) {
      continue;
    }
    const wasOpen = isOpenClawAgentDatabaseOpen(target.sqlitePath);
    try {
      repaired += rewriteDoctorSessionEntries({
        scope: { agentId: target.agentId, env: params.env, storePath: target.storePath },
        sessionKeys,
        transform: stripRuntimeOnlySessionSkillsFields,
      });
    } finally {
      if (!wasOpen) {
        closeOpenClawAgentDatabaseByPath(target.sqlitePath);
      }
    }
  }
  return { found, repaired, scannedStores: targets.length };
}

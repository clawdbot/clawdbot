import fs from "node:fs";
import {
  rewriteDoctorSessionEntries,
  scanDoctorSessionEntriesTolerant,
} from "../config/sessions/session-accessor.js";
import { resolveAllAgentSessionStoreCandidateTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
} from "../state/openclaw-agent-db.js";
import { runDoctorAgentDatabaseOperation } from "./doctor-agent-database-operation.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";

export type SessionDeliveryStateRepairReport = {
  found: number;
  repaired: number;
  scannedStores: number;
};

/** Scan or rewrite legacy delivery fields inside existing session row JSON. */
export function repairCanonicalSessionDeliveryStates(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): SessionDeliveryStateRepairReport {
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
            if (!recoveredFromProjections && normalizeLegacySessionEntryDelivery(entry) !== entry) {
              sessionKeys.push(sessionKey);
            }
          },
        );
        return { found: true, value: sessionKeys.length } as { found: true; value: number };
      },
    });
    if (!operation.ok || !operation.value.found) {
      continue;
    }
    found += operation.value.value;
    if (!params.apply || operation.value.value === 0) {
      continue;
    }
    const wasOpen = isOpenClawAgentDatabaseOpen(target.sqlitePath);
    try {
      repaired += rewriteDoctorSessionEntries({
        scope: { agentId: target.agentId, env: params.env, storePath: target.storePath },
        sessionKeys,
        transform: normalizeLegacySessionEntryDelivery,
        updateDeliveryProjection: true,
      });
    } finally {
      if (!wasOpen) {
        closeOpenClawAgentDatabaseByPath(target.sqlitePath);
      }
    }
  }
  return { found, repaired, scannedStores: targets.length };
}

function listExistingAgentDatabaseTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Array<{ agentId: string; sqlitePath: string; storePath: string }> {
  const seenPaths = new Set<string>();
  return resolveAllAgentSessionStoreCandidateTargetsSync(cfg, { env }).flatMap((target) => {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (seenPaths.has(sqlitePath) || !fs.existsSync(sqlitePath)) {
      return [];
    }
    seenPaths.add(sqlitePath);
    return [{ agentId: target.agentId, sqlitePath, storePath: target.storePath }];
  });
}

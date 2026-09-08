import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { isErrno } from "../../infra/errno.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry-listing.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { listAgentEntries, resolveAgentDir } from "../agent-scope.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedAuthProfileStoreAtDatabasePath,
} from "./persisted.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileStore } from "./types.js";

export type CandidateAuthProfileStore = {
  agentId: string;
  agentDir: string;
  databasePath: string;
  env: NodeJS.ProcessEnv;
};

type CandidateSource = {
  agentId: string;
  agentDir?: string;
  databasePath: string;
};

function canonicalizeDatabasePath(databasePath: string): string {
  return resolvePathViaExistingAncestorSync(path.resolve(databasePath));
}

async function collectStateRootCandidates(env: NodeJS.ProcessEnv): Promise<CandidateSource[]> {
  const agentsRoot = path.join(resolveStateDir(env), "agents");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => {
      const agentId = normalizeAgentId(entry.name);
      const agentDir = path.join(agentsRoot, entry.name, "agent");
      return {
        agentId,
        agentDir,
        databasePath: resolveAuthProfileDatabasePath(agentDir),
      };
    });
}

/**
 * Discover every auth-capable agent database once by canonical filesystem
 * identity. Registered paths cover custom database locations that cannot be
 * reconstructed from an agent directory.
 */
export async function listCandidateAuthProfileStores(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<CandidateAuthProfileStore[]> {
  const env = params.env ?? process.env;
  const sources: CandidateSource[] = [];
  for (const entry of listAgentEntries(params.cfg)) {
    const id = entry.id?.trim();
    if (!id) {
      continue;
    }
    const agentId = normalizeAgentId(id);
    const agentDir = path.resolve(resolveAgentDir(params.cfg, agentId, env));
    sources.push({
      agentId,
      agentDir,
      databasePath: resolveAuthProfileDatabasePath(agentDir),
    });
  }
  sources.push(...(await collectStateRootCandidates(env)));
  for (const registered of listOpenClawRegisteredAgentDatabases({ env })) {
    sources.push({
      agentId: normalizeAgentId(registered.agentId),
      databasePath: registered.path,
    });
  }

  const candidates = new Map<string, CandidateAuthProfileStore>();
  for (const source of sources) {
    const databasePath = canonicalizeDatabasePath(source.databasePath);
    const agentDir = source.agentDir ?? path.dirname(databasePath);
    if (!candidates.has(databasePath)) {
      candidates.set(databasePath, {
        agentId: source.agentId,
        agentDir,
        databasePath,
        env,
      });
    }
  }
  return [...candidates.values()].toSorted((left, right) =>
    left.databasePath.localeCompare(right.databasePath),
  );
}

/** Read an already-discovered candidate without creating a missing database. */
export function loadCandidateAuthProfileStore(
  candidate: CandidateAuthProfileStore,
): AuthProfileStore | null {
  return loadPersistedAuthProfileStoreAtDatabasePath(candidate.databasePath, "agent");
}

/**
 * Update one exact candidate database in a single synchronous SQLite
 * transaction. Callers serialize candidates externally; this never holds two
 * database transactions at once.
 */
export function updateCandidateAuthProfileStore(params: {
  candidate: CandidateAuthProfileStore;
  preserveProfileState?: boolean;
  profileId: string;
  updater: (store: AuthProfileStore) => boolean;
}): { changed: boolean; store: AuthProfileStore } {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const store = loadPersistedAuthProfileStore(params.candidate.agentDir, { database }) ?? {
        version: AUTH_STORE_VERSION,
        profiles: {},
      };
      const changed = params.updater(store);
      if (changed) {
        const profileIds = [params.profileId];
        saveAuthProfileStore(
          store,
          params.candidate.agentDir,
          {
            filterExternalAuthProfiles: false,
            syncExternalCli: false,
            ...(params.preserveProfileState
              ? {
                  preserveOrderProfileIds: profileIds,
                  preserveStateProfileIds: profileIds,
                }
              : {}),
          },
          database,
        );
      }
      return { changed, store };
    },
    {
      agentId: params.candidate.agentId,
      env: params.candidate.env,
      path: params.candidate.databasePath,
    },
  );
}

import fs from "node:fs/promises";
import { listAgentIds, resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import type { GitBackupIdentity } from "../snapshot/git-backup-codec.js";
import {
  createGitBackup,
  initializeGitBackupRepository,
  readGitBackupLog,
  restoreGitBackupRef,
  verifyGitBackupRef,
} from "../snapshot/git-backup.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { shortenHomePath } from "../utils.js";
import {
  recordBackupOutcomeBestEffort,
  resolveBackupAgentRoot,
  resolveRequiredBackupPath,
} from "./backup-shared.js";

type BackupGitCreateOptions = {
  repository?: string;
  all?: boolean;
  global?: boolean;
  agents?: string[];
  push?: boolean;
  excludeSecrets?: boolean;
  json?: boolean;
};

type BackupGitScopeOptions = {
  global?: boolean;
  agent?: string;
};

export const GIT_BACKUP_PUSH_CREDENTIAL_WARNING =
  "Warning: pushed backup history contains credential material; keep the Git remote private.";

async function resolveCreateDatabases(runtime: RuntimeEnv, options: BackupGitCreateOptions) {
  const normalizedAgents = [
    ...new Set(
      (options.agents ?? []).map((agent) => {
        const trimmed = agent.trim();
        if (!trimmed) {
          throw new Error("--agent must not be blank");
        }
        return normalizeAgentId(trimmed);
      }),
    ),
  ];
  const explicit = options.global === true || normalizedAgents.length > 0;
  if (options.all && explicit) {
    throw new Error("Use --all by itself, or select --global and --agent scopes explicitly.");
  }
  if (!options.all && !explicit) {
    throw new Error("Choose at least one Git backup scope: --all, --global, or --agent <id>.");
  }
  let agents: Array<{ agentId: string; databasePath: string }> = [];
  if (options.all || normalizedAgents.length > 0) {
    const config = getRuntimeConfig({ skipPluginValidation: true });
    const agentIds = options.all
      ? listAgentIds(config).toSorted()
      : normalizedAgents.map((agent) => resolveConfiguredAgentId(config, agent));
    agents = await Promise.all(agentIds.map((agentId) => resolveBackupAgentRoot(config, agentId)));
  }
  const databases: Array<{
    path: string;
    identity: GitBackupIdentity;
  }> = [];
  if (options.all || options.global) {
    databases.push({
      path: await fs.realpath(resolveOpenClawStateSqlitePath()),
      identity: { role: "global" },
    });
  }
  // Config owns both the current roster and each agent root; durable registry
  // rows can retain stale paths after an agent moves or is removed.
  for (const { agentId, databasePath } of agents) {
    let resolvedPath: string;
    try {
      resolvedPath = await fs.realpath(databasePath);
    } catch (error) {
      if (options.all && (error as NodeJS.ErrnoException).code === "ENOENT") {
        runtime.error(`Warning: skipping agent ${agentId}: no database at ${databasePath}`);
        continue;
      }
      throw error;
    }
    databases.push({ path: resolvedPath, identity: { role: "agent", agentId } });
  }
  if (databases.length === 0) {
    throw new Error("No Git backup databases were found for the selected scope.");
  }
  return databases;
}

function resolveOneIdentity(options: BackupGitScopeOptions): GitBackupIdentity {
  const agent = options.agent?.trim();
  if (options.global === true && agent) {
    throw new Error("Choose exactly one Git backup scope: --global or --agent <id>.");
  }
  if (options.global !== true && !agent) {
    throw new Error("Choose a Git backup scope: --global or --agent <id>.");
  }
  return options.global === true
    ? { role: "global" }
    : { role: "agent", agentId: normalizeAgentId(agent) };
}

export async function backupGitInitCommand(
  runtime: RuntimeEnv,
  options: { repository?: string; remote?: string; json?: boolean },
): Promise<{ repositoryPath: string }> {
  const result = await initializeGitBackupRepository({
    repositoryPath: resolveRequiredBackupPath(options.repository, "--repository"),
    stateDir: resolveStateDir(),
    remote: options.remote,
  });
  if (options.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(`Git backup repository ready: ${shortenHomePath(result.repositoryPath)}`);
  }
  return result;
}

export async function backupGitCreateCommand(runtime: RuntimeEnv, options: BackupGitCreateOptions) {
  const repositoryPath = resolveRequiredBackupPath(options.repository, "--repository");
  if (options.push && !options.excludeSecrets) {
    runtime.error(GIT_BACKUP_PUSH_CREDENTIAL_WARNING);
  }
  try {
    const result = await createGitBackup({
      repositoryPath,
      stateDir: resolveStateDir(),
      databases: await resolveCreateDatabases(runtime, options),
      all: options.all,
      excludeSecrets: options.excludeSecrets,
      push: options.push,
    });
    // A completed local backup remains successful even when requested remote replication fails;
    // pushFailed records that durable degradation without discarding the recoverable local commit.
    recordBackupOutcomeBestEffort(runtime, {
      kind: "git",
      archivePath: repositoryPath,
      status: "ok",
      target: result.commit,
      error: result.pushWarning,
      ...(result.pushWarning ? { pushFailed: true } : {}),
    });
    if (options.json) {
      writeRuntimeJson(runtime, result);
    } else if (result.noChanges) {
      runtime.log(`Git backup: no changes (${shortenHomePath(repositoryPath)})`);
    } else {
      runtime.log(`Git backup committed: ${result.commit}`);
    }
    if (result.pushWarning) {
      runtime.error(`Warning: Git backup committed, but push failed: ${result.pushWarning}`);
    }
    return result;
  } catch (error) {
    recordBackupOutcomeBestEffort(runtime, {
      kind: "git",
      archivePath: repositoryPath,
      status: "failed",
      error: formatErrorMessage(error),
    });
    throw error;
  }
}

export async function backupGitLogCommand(
  runtime: RuntimeEnv,
  options: { repository?: string; limit?: number; json?: boolean },
) {
  const repositoryPath = resolveRequiredBackupPath(options.repository, "--repository");
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer.");
  }
  const entries = await readGitBackupLog({ repositoryPath, limit });
  if (options.json) {
    writeRuntimeJson(runtime, { repositoryPath, entries });
  } else if (entries.length === 0) {
    runtime.log(`No Git backup commits in ${shortenHomePath(repositoryPath)}.`);
  } else {
    runtime.log(
      entries.map((entry) => `${entry.commit}\t${entry.date}\t${entry.message}`).join("\n"),
    );
  }
  return entries;
}

export async function backupGitVerifyCommand(
  runtime: RuntimeEnv,
  options: BackupGitScopeOptions & { repository?: string; ref?: string; json?: boolean },
) {
  const result = await verifyGitBackupRef({
    repositoryPath: resolveRequiredBackupPath(options.repository, "--repository"),
    identity: resolveOneIdentity(options),
    ref: options.ref,
  });
  if (options.json) {
    writeRuntimeJson(runtime, result);
  } else {
    for (const table of result.tables) {
      runtime.log(`${table.ok ? "ok" : "failed"}\t${table.table}\t${table.rows}\t${table.sha256}`);
    }
    runtime.log(`Git backup verified: ${result.commit}`);
  }
  return result;
}

export async function backupGitRestoreCommand(
  runtime: RuntimeEnv,
  options: BackupGitScopeOptions & {
    repository?: string;
    ref?: string;
    target?: string;
    json?: boolean;
  },
) {
  const result = await restoreGitBackupRef({
    repositoryPath: resolveRequiredBackupPath(options.repository, "--repository"),
    identity: resolveOneIdentity(options),
    ref: options.ref,
    targetPath: resolveRequiredBackupPath(options.target, "--target"),
  });
  if (options.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(`Git backup restored: ${shortenHomePath(result.targetPath)} (${result.commit})`);
    if (result.excludedTables.length > 0) {
      runtime.error(
        `Warning: this redacted backup omits tables: ${result.excludedTables.join(", ")}`,
      );
    }
  }
  return result;
}

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reclaimDefinitelyStaleFileLock } from "openclaw/plugin-sdk/file-lock";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

const RETIRED_QMD_GLOBAL_LOCK_NAME = "embed.lock.lock";
const RETIRED_QMD_AGENT_LOCK_NAME = "qmd-write.lock.lock";

async function readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
  try {
    return (await fs.readdir(directoryPath, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch {
    return [];
  }
}

async function collectRetiredQmdFileLocks(stateDir: string): Promise<string[]> {
  const stateEntries = await readDirectoryEntries(stateDir);
  const lockPaths: string[] = [];
  if (stateEntries.some((entry) => entry.name === "qmd" && entry.isDirectory())) {
    const qmdDir = path.join(stateDir, "qmd");
    const qmdEntries = await readDirectoryEntries(qmdDir);
    if (qmdEntries.some((entry) => entry.name === RETIRED_QMD_GLOBAL_LOCK_NAME && entry.isFile())) {
      lockPaths.push(path.join(qmdDir, RETIRED_QMD_GLOBAL_LOCK_NAME));
    }
  }
  if (!stateEntries.some((entry) => entry.name === "agents" && entry.isDirectory())) {
    return lockPaths;
  }
  const agentsDir = path.join(stateDir, "agents");
  for (const entry of await readDirectoryEntries(agentsDir)) {
    if (!entry.isDirectory() || entry.name !== normalizeAgentId(entry.name)) {
      continue;
    }
    const agentDir = path.join(agentsDir, entry.name);
    const agentEntries = await readDirectoryEntries(agentDir);
    if (
      agentEntries.some(
        (agentEntry) => agentEntry.name === RETIRED_QMD_AGENT_LOCK_NAME && agentEntry.isFile(),
      )
    ) {
      lockPaths.push(path.join(agentDir, RETIRED_QMD_AGENT_LOCK_NAME));
    }
  }
  return lockPaths;
}

async function collectRetiredQmdWorkspaceHomes(stateDir: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  const homes: string[] = [];
  for (const entry of await readDirectoryEntries(agentsDir)) {
    if (!entry.isDirectory() || entry.name !== normalizeAgentId(entry.name)) {
      continue;
    }
    const agentDir = path.join(agentsDir, entry.name);
    const agentEntries = await readDirectoryEntries(agentDir);
    if (agentEntries.some((candidate) => candidate.name === "qmd" && candidate.isDirectory())) {
      homes.push(path.join(agentDir, "qmd"));
    }
  }
  return homes;
}

export const qmdWorkspaceStateMigration: PluginDoctorStateMigration = {
  id: "memory-core-qmd-workspace-retired",
  label: "Memory Core retired QMD workspaces",
  doctorOnly: true,
  async detectLegacyState(params) {
    const homes = await collectRetiredQmdWorkspaceHomes(params.stateDir);
    if (homes.length === 0) {
      return null;
    }
    return {
      preview: homes.map(
        (home) =>
          `- Retired Memory Core QMD workspace: ${home} -> remove derived index, config, cache, and session-export artifacts`,
      ),
    };
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    for (const home of await collectRetiredQmdWorkspaceHomes(params.stateDir)) {
      try {
        await fs.rm(home, { recursive: true, force: true });
        changes.push(`Removed retired Memory Core QMD workspace: ${home}`);
      } catch (err) {
        warnings.push(`Failed removing retired Memory Core QMD workspace ${home}: ${String(err)}`);
      }
    }
    return { changes, warnings };
  },
};

export const qmdLocksStateMigration: PluginDoctorStateMigration = {
  id: "memory-core-qmd-file-locks-to-sqlite-leases",
  label: "Memory Core retired QMD file locks",
  async detectLegacyState(params) {
    const lockPaths = await collectRetiredQmdFileLocks(params.stateDir);
    if (lockPaths.length === 0) {
      return null;
    }
    return {
      preview: lockPaths.map(
        (lockPath) =>
          `- Retired Memory Core QMD file lock: ${lockPath} -> remove only if definitely stale (coordination now uses SQLite leases)`,
      ),
    };
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    for (const lockPath of await collectRetiredQmdFileLocks(params.stateDir)) {
      try {
        const result = await reclaimDefinitelyStaleFileLock(lockPath);
        if (result === "removed") {
          changes.push(`Removed retired Memory Core QMD file lock: ${lockPath}`);
        } else if (result === "retained") {
          warnings.push(
            `Retained retired Memory Core QMD file lock because its owner is live or ambiguous: ${lockPath}`,
          );
        }
      } catch (err) {
        warnings.push(
          `Failed removing retired Memory Core QMD file lock ${lockPath}: ${String(err)}`,
        );
      }
    }
    return { changes, warnings };
  },
};

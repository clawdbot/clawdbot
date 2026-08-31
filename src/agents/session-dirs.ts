/**
 * Agent session directory discovery helpers.
 * Lists per-agent `sessions` directories under state roots in sorted order for
 * callers that scan persisted session stores.
 */
import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function mapAgentSessionDirs(
  agentsDir: string,
  entries: Dirent[],
  includeDirName?: (dirName: string) => boolean,
): string[] {
  return entries
    .filter((entry) => entry.isDirectory() && (includeDirName?.(entry.name) ?? true))
    .map((entry) => path.join(agentsDir, entry.name, "sessions"))
    .toSorted((a, b) => a.localeCompare(b));
}

/** Synchronous variant of per-agent session directory discovery. */
export function resolveAgentSessionDirsFromAgentsDirSync(
  agentsDir: string,
  includeDirName?: (dirName: string) => boolean,
): string[] {
  let entries: Dirent[];
  try {
    entries = fsSync.readdirSync(agentsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  return mapAgentSessionDirs(agentsDir, entries, includeDirName);
}

/** Lists per-agent session directories under a state directory. */
export async function resolveAgentSessionDirs(stateDir: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  return mapAgentSessionDirs(agentsDir, entries);
}

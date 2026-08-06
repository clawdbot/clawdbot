/**
 * Agent session directory discovery helpers.
 * Lists per-agent `sessions` directories under state roots in sorted order for
 * callers that scan persisted session stores.
 */
import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function mapAgentSessionDirs(agentsDir: string, entries: Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(agentsDir, entry.name, "sessions"))
    .toSorted((a, b) => a.localeCompare(b));
}

/** Synchronous variant of per-agent session directory discovery. */
export function resolveAgentSessionDirsFromAgentsDirSync(agentsDir: string): string[] {
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

  return mapAgentSessionDirs(agentsDir, entries);
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

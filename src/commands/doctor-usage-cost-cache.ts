/** Doctor cleanup for rebuildable legacy usage-cost cache sidecars. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStateDir } from "../config/paths.js";
import { maybeScrubConfigAuditLog } from "./doctor-config-audit-scrub.js";

const LEGACY_USAGE_COST_TEMP_GRACE_MS = 10_000;

function isLegacyUsageCostCacheTempName(name: string): boolean {
  return (
    /^\.usage-cost-cache\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u.test(
      name,
    ) ||
    /^\.usage-cost-cache(?:\.json)?\.\d+\.tmp$/u.test(name) ||
    /^\.usage-cost-cache\.json\.lock\.\d+(?:\.\d+)?\.tmp$/u.test(name)
  );
}

async function detectLegacyUsageCostCacheFiles(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Promise<string[]> {
  const stateDir = resolveStateDir(params?.env ?? process.env, params?.homedir ?? os.homedir);
  const sessionDirs = [path.join(stateDir, "sessions")];
  const agentsDir = path.join(stateDir, "agents");
  const agentEntries = await fs.readdir(agentsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of agentEntries) {
    if (entry.isDirectory()) {
      sessionDirs.push(path.join(agentsDir, entry.name, "sessions"));
    }
  }
  const files: string[] = [];
  for (const sessionDir of sessionDirs) {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(sessionDir, entry.name);
      if (entry.name === ".usage-cost-cache.json" || entry.name === ".usage-cost-cache.json.lock") {
        files.push(filePath);
        continue;
      }
      if (isLegacyUsageCostCacheTempName(entry.name)) {
        const stats = await fs.stat(filePath).catch(() => null);
        if (stats && Date.now() - stats.mtimeMs >= LEGACY_USAGE_COST_TEMP_GRACE_MS) {
          files.push(filePath);
        }
      }
    }
  }
  return files.toSorted();
}

async function maybeRemoveLegacyUsageCostCacheFiles(params: {
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Promise<void> {
  const files = await detectLegacyUsageCostCacheFiles(params);
  if (files.length === 0) {
    return;
  }
  if (!params.shouldRepair) {
    note(
      `${files.length} rebuildable usage-cost cache ${files.length === 1 ? "file remains" : "files remain"}. Run \`openclaw doctor --fix\` to remove ${files.length === 1 ? "it" : "them"}.`,
      "Usage cost cache",
    );
    return;
  }
  const failures: string[] = [];
  for (const filePath of files) {
    await fs.rm(filePath, { force: true }).catch((error: unknown) => {
      failures.push(`${filePath}: ${String(error)}`);
    });
  }
  if (failures.length > 0) {
    note(
      `Failed removing legacy usage-cost cache files:\n${failures.join("\n")}`,
      "Usage cost cache",
    );
    return;
  }
  note(
    `Removed ${files.length} rebuildable legacy usage-cost cache ${files.length === 1 ? "file" : "files"}; SQLite rebuilds the cache on demand.`,
    "Usage cost cache",
  );
}

async function maybeRemoveLegacySkillUploadTree(params: {
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Promise<void> {
  const stateDir = resolveStateDir(params.env ?? process.env, params.homedir ?? os.homedir);
  const uploadRoot = path.join(stateDir, "tmp", "skill-uploads");
  const stats = await fs.lstat(uploadRoot).catch(() => null);
  if (!stats) {
    return;
  }
  if (!params.shouldRepair) {
    note(
      "Legacy skill-upload staging remains. Run `openclaw doctor --fix` to discard it; active uploads now live in SQLite and must be retried.",
      "Skill uploads",
    );
    return;
  }
  try {
    // Removing a symlink removes only the fixed legacy entry, never its target.
    if (stats.isSymbolicLink()) {
      await fs.unlink(uploadRoot);
    } else {
      await fs.rm(uploadRoot, { recursive: true, force: true });
    }
  } catch (error) {
    note(`Failed removing legacy skill-upload staging: ${String(error)}`, "Skill uploads");
    return;
  }
  note(
    "Removed legacy skill-upload staging; unfinished transient uploads must be retried.",
    "Skill uploads",
  );
}

export async function maybeRepairLegacyRuntimeFiles(
  shouldRepair: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await maybeScrubConfigAuditLog({ shouldRepair, env });
  await maybeRemoveLegacyUsageCostCacheFiles({ shouldRepair, env });
  await maybeRemoveLegacySkillUploadTree({ shouldRepair, env });
}

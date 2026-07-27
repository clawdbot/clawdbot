import fs from "node:fs/promises";
import path from "node:path";
import { resolveCanonicalConfigPath, resolveNewStateDir } from "../config/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveHomeDir } from "../utils.js";

export async function maybeMigrateLegacyConfig(): Promise<string[]> {
  const changes: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return changes;
  }

  const targetPath = resolveCanonicalConfigPath();
  const targetDir = path.dirname(targetPath);
  try {
    await fs.access(targetPath);
    return changes;
  } catch {
    // missing config
  }

  const legacyCandidates = [path.join(home, ".clawdbot", "clawdbot.json")];
  let legacyPath: string | null = null;
  for (const candidate of legacyCandidates) {
    try {
      await fs.access(candidate);
      // When the copy target is the default canonical root (~/.openclaw), copy only
      // out of a legacy dir the state-dir migration RESOLVED: a symlink pointing at
      // that same canonical root. Copying from an unresolved (real, or elsewhere-
      // pointing) legacy dir would plant the config into a root the migration has
      // not converged, forging the initialized-state-root marker
      // (state-migrations.state-dir.ts) and letting a later boot checkpoint while
      // real data sits in the legacy dir. Custom state dirs, explicit config paths,
      // and profiles are outside that migration's ownership and keep copying.
      const targetsDefaultStateRoot =
        path.resolve(targetDir) === path.resolve(resolveNewStateDir(() => home));
      if (targetsDefaultStateRoot) {
        const legacyDir = path.dirname(candidate);
        const resolvesToTarget = await Promise.all([fs.realpath(legacyDir), fs.realpath(targetDir)])
          .then(([resolvedLegacy, resolvedTarget]) => resolvedLegacy === resolvedTarget)
          .catch(() => false);
        if (!(await fs.lstat(legacyDir)).isSymbolicLink() || !resolvesToTarget) {
          continue;
        }
      }
      legacyPath = candidate;
      break;
    } catch {
      // continue
    }
  }
  if (!legacyPath) {
    return changes;
  }

  await fs.mkdir(targetDir, { recursive: true });
  try {
    await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch (error) {
    // A concurrently created target wins; every other failure must remain actionable.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") {
      throw new Error(
        `Failed to migrate legacy config ${legacyPath} -> ${targetPath}: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
  }
  return changes;
}

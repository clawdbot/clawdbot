import fs from "node:fs/promises";
import { formatErrorMessage } from "./errors.js";
import { pathExists } from "./fs-safe.js";
import { assertCanonicalPathWithinBase, resolveSafeInstallDir } from "./install-safe-path.js";

export async function resolveCanonicalInstallTarget(params: {
  baseDir: string;
  id: string;
  invalidNameMessage: string;
  boundaryLabel: string;
  nameEncoder?: (id: string) => string;
}): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  await fs.mkdir(params.baseDir, { recursive: true });
  const targetDirResult = resolveSafeInstallDir({
    baseDir: params.baseDir,
    id: params.id,
    invalidNameMessage: params.invalidNameMessage,
    nameEncoder: params.nameEncoder,
  });
  if (!targetDirResult.ok) {
    return { ok: false, error: targetDirResult.error };
  }
  try {
    await assertCanonicalPathWithinBase({
      baseDir: params.baseDir,
      candidatePath: targetDirResult.path,
      boundaryLabel: params.boundaryLabel,
    });
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
  return { ok: true, targetDir: targetDirResult.path };
}

export async function ensureInstallTargetAvailable(params: {
  mode: "install" | "update";
  targetDir: string;
  alreadyExistsError: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (params.mode === "install" && (await pathExists(params.targetDir))) {
    return { ok: false, error: params.alreadyExistsError };
  }
  return { ok: true };
}

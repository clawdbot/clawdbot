/**
 * Manages transient transcripts used for internal session side effects.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

function resolveInternalSessionEffectsDir(): string {
  return path.resolve(resolveStateDir(), "internal-agent-runs");
}

/** Resolves the private transcript path for an internal session-effect run. */
export function resolveInternalSessionEffectsTranscriptPath(runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "run";
  return path.join(resolveInternalSessionEffectsDir(), `${safeRunId}.jsonl`);
}

/** Checks whether a transcript belongs to the private internal-run directory. */
export function isInternalSessionEffectsTranscriptPath(
  sessionFile: string | undefined,
): sessionFile is string {
  return Boolean(
    sessionFile && path.dirname(path.resolve(sessionFile)) === resolveInternalSessionEffectsDir(),
  );
}

/** Copies or creates a private transcript for internal session-effect recovery. */
export async function prepareInternalSessionEffectsTranscript(params: {
  sessionFile?: string;
  runId: string;
}): Promise<string> {
  // Callers must persist this path in an owning lifecycle record and invoke
  // removeInternalSessionEffectsTranscript once the recovered output is no longer needed.
  const sessionFile = resolveInternalSessionEffectsTranscriptPath(params.runId);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  if (!params.sessionFile) {
    await fs.writeFile(sessionFile, "", { mode: 0o600 });
    await fs.chmod(sessionFile, 0o600);
    return sessionFile;
  }
  try {
    const contents = await fs.readFile(params.sessionFile);
    await fs.writeFile(sessionFile, contents, { mode: 0o600 });
    await fs.chmod(sessionFile, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await fs.writeFile(sessionFile, "", { mode: 0o600 });
    await fs.chmod(sessionFile, 0o600);
  }
  return sessionFile;
}

/** Removes an internal session-effect transcript if it is inside the owned dir. */
export async function removeInternalSessionEffectsTranscript(
  sessionFile: string | undefined,
): Promise<void> {
  if (!isInternalSessionEffectsTranscriptPath(sessionFile)) {
    return;
  }
  const resolved = path.resolve(sessionFile);
  try {
    await fs.rm(resolved, { force: true });
  } catch {
    // Best-effort privacy/disk cleanup; run cleanup must not fail on temp-file races.
  }
}

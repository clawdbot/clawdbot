import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export function resolveInternalSessionEffectsTranscriptPath(runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "run";
  return path.join(resolveStateDir(), "internal-agent-runs", `${safeRunId}.jsonl`);
}

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

export async function removeInternalSessionEffectsTranscript(
  sessionFile: string | undefined,
): Promise<void> {
  const dir = path.join(resolveStateDir(), "internal-agent-runs");
  const resolved = sessionFile ? path.resolve(sessionFile) : "";
  if (!resolved || path.dirname(resolved) !== path.resolve(dir)) {
    return;
  }
  try {
    await fs.rm(resolved, { force: true });
  } catch {
    // Best-effort privacy/disk cleanup; run cleanup must not fail on temp-file races.
  }
}

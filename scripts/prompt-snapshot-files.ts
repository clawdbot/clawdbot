import fs from "node:fs/promises";
import path from "node:path";
import { CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR } from "../test/helpers/agents/prompt-snapshot-paths.js";

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export async function listCommittedSnapshotArtifactPaths(root: string): Promise<string[]> {
  let committedEntries: string[];
  try {
    committedEntries = await fs.readdir(
      path.resolve(root, CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR),
    );
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    committedEntries = [];
  }
  return committedEntries
    .filter((entry) => entry.endsWith(".md") || entry.endsWith(".json"))
    .map((entry) => path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, entry));
}

export async function deleteStalePromptSnapshotFiles(
  root: string,
  files: Array<{ path: string }>,
): Promise<string[]> {
  const expectedPaths = new Set(files.map((file) => file.path));
  const stalePaths = (await listCommittedSnapshotArtifactPaths(root)).filter(
    (snapshotPath) => !expectedPaths.has(snapshotPath),
  );
  await Promise.all(stalePaths.map((snapshotPath) => fs.rm(path.resolve(root, snapshotPath))));
  return stalePaths;
}

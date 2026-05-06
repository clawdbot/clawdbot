import "../infra/fs-safe-defaults.js";
import { pathExists } from "../infra/fs-safe.js";
import { tryReadJson, tryReadJsonSync, writeJson, writeJsonSync } from "../infra/json-files.js";

/** Read small JSON blobs synchronously for token/state caches. */
// oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters -- public SDK compatibility helper.
export function loadJsonFile<T = unknown>(filePath: string): T | undefined {
  return tryReadJsonSync<T>(filePath) ?? undefined;
}

/** Persist small JSON blobs synchronously with restrictive permissions. */
export const saveJsonFile = writeJsonSync;

/** Read JSON from disk and fall back cleanly when the file is missing or invalid. */
export async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  const parsed = await tryReadJson<T>(filePath);
  if (parsed != null) {
    return { value: parsed, exists: true };
  }
  return { value: fallback, exists: await pathExists(filePath) };
}

/** Write JSON with secure file permissions and atomic replacement semantics. */
export async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  await writeJson(filePath, value, {
    mode: 0o600,
    dirMode: 0o700,
    trailingNewline: true,
  });
}

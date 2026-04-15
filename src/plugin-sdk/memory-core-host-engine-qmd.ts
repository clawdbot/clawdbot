// Compat barrel: memory-core-host-engine-qmd
// Maps the memory-core extension's QMD (query/markdown/document) engine to src/memory/* modules.

export {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
  type SessionFileEntry,
} from "../memory/session-files.js";

export { extractKeywords } from "../memory/query-expansion.js";

export {
  resolveCliSpawnInvocation,
  runCliCommand,
} from "../memory/qmd-process.js";

export {
  parseQmdQueryJson,
  type QmdQueryResult,
} from "../memory/qmd-query-parser.js";

export {
  deriveQmdScopeChannel,
  deriveQmdScopeChatType,
  isQmdScopeAllowed,
} from "../memory/qmd-scope.js";

/** Parse the usage-count prefix from a session file name (e.g. "42-2024-01-01T...").
 *  Returns the session id portion after stripping the count prefix, or the raw name if unparseable. */
export function parseUsageCountedSessionIdFromFileName(fileName: string): string {
  const match = /^\d+-(.+)$/.exec(fileName);
  return match ? match[1] : fileName;
}

/** Check whether the qmd binary is available on PATH.
 *  Returns true if `qmd --version` exits cleanly, false otherwise. */
export async function checkQmdBinaryAvailability(): Promise<boolean> {
  const { resolveCliSpawnInvocation: resolve, runCliCommand: run } = await import(
    "../memory/qmd-process.js"
  );
  try {
    const inv = resolve({ args: ["--version"] });
    const result = await run({ ...inv, args: ["--version"] });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

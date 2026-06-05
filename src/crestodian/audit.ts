// Crestodian audit helpers append JSONL records for approved local-state changes.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { appendRegularFile } from "../infra/fs-safe.js";

/**
 * Append-only audit log helpers for Crestodian writes.
 *
 * Discovery and read-only commands stay quiet; persistent operations append a
 * JSONL entry under the state directory with config hashes and redacted details.
 */
type CrestodianAuditEntry = {
  timestamp: string;
  operation: string;
  summary: string;
  configPath?: string;
  configHashBefore?: string | null;
  configHashAfter?: string | null;
  details?: Record<string, unknown>;
};

/** Resolve the JSONL audit path for Crestodian persistent operations. */
export function resolveCrestodianAuditPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir = resolveStateDir(env),
): string {
  return path.join(stateDir, "audit", "crestodian.jsonl");
}

/** Append one Crestodian audit entry and return the file path written. */
export async function appendCrestodianAuditEntry(
  entry: Omit<CrestodianAuditEntry, "timestamp">,
  opts: { env?: NodeJS.ProcessEnv; auditPath?: string } = {},
): Promise<string> {
  const auditPath = opts.auditPath ?? resolveCrestodianAuditPath(opts.env);
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
  } satisfies CrestodianAuditEntry);
  // Audit writes reject symlinked parents so approval records cannot be redirected silently.
  await appendRegularFile({
    filePath: auditPath,
    content: `${line}\n`,
    rejectSymlinkParents: true,
  });
  return auditPath;
}

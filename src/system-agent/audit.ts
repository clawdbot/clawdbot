// OpenClaw audit helpers append JSONL records for approved local-state changes.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { appendRegularFile } from "../infra/fs-safe.js";

/**
 * Append-only audit log helpers for OpenClaw writes.
 *
 * Discovery and read-only commands stay quiet; persistent operations append a
 * JSONL entry under the state directory with config hashes and redacted details.
 */
type SystemAgentAuditEntry = {
  timestamp: string;
  operation: string;
  summary: string;
  configPath?: string;
  configHashBefore?: string | null;
  configHashAfter?: string | null;
  details?: Record<string, unknown>;
};

/** Resolve the JSONL audit path for OpenClaw persistent operations. */
export function resolveSystemAgentAuditPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir = resolveStateDir(env),
): string {
  return path.join(stateDir, "audit", "system-agent.jsonl");
}

/** Append one OpenClaw audit entry and return the file path written. */
export async function appendSystemAgentAuditEntry(
  entry: Omit<SystemAgentAuditEntry, "timestamp">,
  opts: { env?: NodeJS.ProcessEnv; auditPath?: string } = {},
): Promise<string> {
  const auditPath = opts.auditPath ?? resolveSystemAgentAuditPath(opts.env);
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
  } satisfies SystemAgentAuditEntry);
  // Audit writes reject symlinked parents so approval records cannot be redirected silently.
  await appendRegularFile({
    filePath: auditPath,
    content: `${line}\n`,
    rejectSymlinkParents: true,
  });
  return auditPath;
}

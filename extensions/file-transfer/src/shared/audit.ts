// Append-only audit log for file-transfer operations.
//
// Records every decision (allow/deny/error) at the gateway-side tool
// layer. Lands at ~/.openclaw/audit/file-transfer.jsonl. Rotation is
// caller's responsibility — the file grows unbounded.
//
// Log records do NOT include file contents or hashes of secrets. They do
// include canonical paths and sha256 of the payload, so treat the audit
// file as sensitive.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type FileTransferAuditOp = "file.fetch" | "dir.list" | "dir.fetch" | "file.write";

type FileTransferAuditDecision =
  | "allowed"
  | "allowed:once"
  | "allowed:always"
  | "denied:no_policy"
  | "denied:policy"
  | "denied:approval"
  | "denied:command_not_allowed"
  | "denied:symlink_escape"
  | "error";

type FileTransferAuditRecord = {
  timestamp: string;
  op: FileTransferAuditOp;
  nodeId: string;
  nodeDisplayName?: string;
  requestedPath: string;
  canonicalPath?: string;
  decision: FileTransferAuditDecision;
  errorCode?: string;
  errorMessage?: string;
  sizeBytes?: number;
  sha256?: string;
  durationMs?: number;
  // Tying back to the agent that initiated the op
  requesterAgentId?: string;
  sessionKey?: string;
  // Reason text for denials
  reason?: string;
};

let auditDirPromise: Promise<string> | null = null;

async function ensureAuditDir(): Promise<string> {
  if (auditDirPromise) {
    return auditDirPromise;
  }
  const promise = (async () => {
    const dir = path.join(os.homedir(), ".openclaw", "audit");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  })();
  // If the mkdir rejects (transient permission error etc.), clear the
  // cached singleton so the NEXT call retries instead of permanently
  // silencing the audit log.
  promise.catch(() => {
    if (auditDirPromise === promise) {
      auditDirPromise = null;
    }
  });
  auditDirPromise = promise;
  return promise;
}

function auditFilePath(dir: string): string {
  return path.join(dir, "file-transfer.jsonl");
}

/**
 * Append an audit record. Best-effort — failures are logged to stderr and
 * never propagated to the caller (the caller's operation is the source of
 * truth, not the audit write).
 */
export async function appendFileTransferAudit(
  record: Omit<FileTransferAuditRecord, "timestamp">,
): Promise<void> {
  try {
    const dir = await ensureAuditDir();
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...record,
    })}\n`;
    await fs.appendFile(auditFilePath(dir), line, { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[file-transfer:audit] append failed: ${String(e)}\n`);
  }
}

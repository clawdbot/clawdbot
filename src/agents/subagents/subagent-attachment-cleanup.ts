/** Removes host-owned subagent attachment artifacts by generated identity. */
import fsSync, { promises as fs } from "node:fs";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSubagentAttachmentDir } from "./subagent-attachment-paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveOwnedAttachmentDir(params: {
  childSessionKey: string;
  attachmentId: string;
}): string {
  if (!UUID_RE.test(params.attachmentId)) {
    throw new Error("invalid subagent attachment identity");
  }
  return resolveSubagentAttachmentDir({
    agentId: resolveAgentIdFromSessionKey(params.childSessionKey),
    attachmentId: params.attachmentId,
  });
}

export async function cleanupMaterializedSubagentAttachments(params: {
  childSessionKey: string;
  attachmentId: string;
}): Promise<void> {
  await fs.rm(resolveOwnedAttachmentDir(params), { recursive: true, force: true });
}

export function cleanupMaterializedSubagentAttachmentsSync(params: {
  childSessionKey: string;
  attachmentId: string;
}): void {
  fsSync.rmSync(resolveOwnedAttachmentDir(params), { recursive: true, force: true });
}

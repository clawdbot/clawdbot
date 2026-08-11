import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

const legacyAttachmentLog = createSubsystemLogger("state/legacy-attachment-cleanup");
const GENERATED_SUBAGENT_ATTACHMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePayload(value: string): Record<string, unknown> | null {
  try {
    return asNullableRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Retire shipped unconfined attachment cleanup before canonical registry hydration. */
export function retireLegacySubagentAttachmentCleanup(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) {
    return;
  }
  const rows = db.prepare("SELECT run_id, payload_json FROM subagent_runs").all() as Array<{
    run_id: string;
    payload_json: string;
  }>;
  const update = db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?");
  const warnedRoots = new Set<string>();
  for (const row of rows) {
    const payload = parsePayload(row.payload_json);
    const storedRoot = payload ? textField(payload, "attachmentsRootDir") : null;
    const storedDir = payload ? textField(payload, "attachmentsDir") : null;
    if (!payload || !storedRoot || !storedDir) {
      continue;
    }
    if (
      Object.hasOwn(payload, "attachmentsSandboxSessionKey") ||
      Object.hasOwn(payload, "attachmentsSandboxAgentId") ||
      Object.hasOwn(payload, "attachmentsSandboxWorkspaceDir") ||
      Object.hasOwn(payload, "attachmentsSandboxDir")
    ) {
      continue;
    }
    const rootDir = path.resolve(storedRoot);
    const attachmentsDir = path.resolve(storedDir);
    const attachmentId = path.relative(rootDir, attachmentsDir);
    if (
      path.basename(rootDir) !== "attachments" ||
      path.basename(path.dirname(rootDir)) !== ".openclaw" ||
      path.dirname(attachmentId) !== "." ||
      !GENERATED_SUBAGENT_ATTACHMENT_ID.test(attachmentId)
    ) {
      continue;
    }
    if (!warnedRoots.has(rootDir) && warnedRoots.size < 4) {
      warnedRoots.add(rootDir);
      legacyAttachmentLog.warn(
        warnedRoots.size < 4
          ? `Legacy subagent attachments may remain at ${rootDir}; inspect and remove them manually. Unsafe cleanup metadata is being retired.`
          : "Additional legacy subagent attachment roots were omitted from this warning.",
      );
    }
    // v2026.7.x stored no sandbox cleanup boundary. A host removal can race a
    // writable sandbox. Warn before retiring the receipt without touching its path.
    delete payload.attachmentsDir;
    delete payload.attachmentsRootDir;
    delete payload.retainAttachmentsOnKeep;
    update.run(JSON.stringify(payload), row.run_id);
  }
}

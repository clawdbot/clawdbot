import { createHash } from "node:crypto";
import { isAllowedToolCallName } from "../agents/tool-call-shared.js";
import { nonEmptyString } from "./agent-event-audit-provenance.js";

export function auditToolName(value: unknown): string | undefined {
  const toolName = nonEmptyString(value)?.trim();
  if (!toolName) {
    return undefined;
  }
  // Tool lifecycle producers include provider-controlled streams. Preserve
  // only the compact model-facing name contract at the durable boundary.
  return isAllowedToolCallName(toolName, null) ? toolName : "unknown";
}

export function auditToolCallId(value: unknown): string | undefined {
  const toolCallId = nonEmptyString(value);
  if (!toolCallId) {
    return undefined;
  }
  // Call ids remain useful for correlation, but their provider-owned bytes
  // are not operator metadata and must never enter the ledger verbatim.
  return `sha256:${createHash("sha256").update(toolCallId).digest("hex")}`;
}

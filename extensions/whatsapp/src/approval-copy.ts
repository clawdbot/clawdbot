// WhatsApp-specific approval copy helpers.
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";

const DEFAULT_EXEC_PURPOSE = "Runs the command shown below.";

/** Adds a short purpose immediately below the approval heading. */
export function addWhatsAppExecPurpose(params: {
  text?: string;
  approvalKind: ChannelApprovalKind;
  purpose?: string | null;
}): string | undefined {
  if (!params.text || params.approvalKind !== "exec") {
    return params.text;
  }
  const purpose = params.purpose?.trim() || DEFAULT_EXEC_PURPOSE;
  const section = `**What this does:** ${purpose}`;
  const firstSectionEnd = params.text.indexOf("\n\n");
  return firstSectionEnd < 0
    ? `${params.text}\n\n${section}`
    : `${params.text.slice(0, firstSectionEnd)}\n\n${section}\n\n${params.text.slice(firstSectionEnd + 2)}`;
}

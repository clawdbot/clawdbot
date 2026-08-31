/** Shared export-command parsing and target session resolution helpers. */
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ExecToolDetails } from "../../agents/bash-tools.exec-types.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  buildExecApprovalPendingReplyPayload,
  buildExecApprovalUnavailableReplyPayload,
} from "../../infra/exec-approval-reply.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { escapeRegExp } from "../../shared/regexp.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";

/** Resolved session entry and scoped transcript identity targeted by an export command. */
interface ExportCommandSessionTarget {
  agentId: string;
  entry: SessionEntry;
  sessionId: string;
  sessionFile: string;
  sessionKey: string;
  storePath: string;
}

const MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS = 512;

/** Parses an optional non-flag output path from export command text. */
export function parseExportCommandOutputPath(
  commandBodyNormalized: string,
  aliases: readonly string[],
): { outputPath?: string; error?: string } {
  const normalized = commandBodyNormalized.trim();
  if (aliases.some((alias) => normalized === `/${alias}`)) {
    return {};
  }
  const aliasPattern = aliases.map(escapeRegExp).join("|");
  const args = normalized.replace(new RegExp(`^/(${aliasPattern})\\s*`), "").trim();
  const outputPath = args.split(/\s+/).find((part) => !part.startsWith("-"));
  if (outputPath && outputPath.length > MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS) {
    return {
      error: `❌ Output path is too long. Keep it at ${MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS} characters or less.`,
    };
  }
  return { outputPath };
}

/** Resolves the session store entry and transcript file for an export command. */
export function resolveExportCommandSessionTarget(
  params: HandleCommandsParams,
): ExportCommandSessionTarget | ReplyPayload {
  const targetAgentId = resolveAgentIdFromSessionKey(params.sessionKey) || params.agentId;
  if (!targetAgentId) {
    return { text: `❌ Failed to resolve agent for session: ${params.sessionKey}` };
  }
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(targetAgentId);
  const entry = loadSessionEntryReadOnly({
    storePath,
    sessionKey: params.sessionKey,
    clone: false,
  });
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return { text: `❌ Session not found: ${params.sessionKey}` };
  }

  try {
    const sessionFile = resolveSessionFilePathCore(
      sessionId,
      entry,
      resolveSessionFilePathOptions({ agentId: targetAgentId, storePath }),
    );
    return {
      agentId: targetAgentId,
      entry,
      sessionFile,
      sessionId,
      sessionKey: params.sessionKey,
      storePath,
    };
  } catch (err) {
    return {
      text: `❌ Failed to resolve session file: ${formatErrorMessage(err)}`,
    };
  }
}

/** Distinguishes command error replies from successful export session targets. */
export function isReplyPayload(
  value: ExportCommandSessionTarget | ReplyPayload,
): value is ReplyPayload {
  return "text" in value;
}

/** Typed exec state owns the lead; command output cannot establish approval or dispatch. */
export function formatExportExecResult(
  label: string,
  result: {
    content?: Array<{ type: string; text?: string }>;
    details?: ExecToolDetails;
  },
): string {
  const details = result.details;
  let lead: string;
  let output: string | undefined;
  switch (details?.status) {
    case "approval-pending": {
      const decisions = details.allowedDecisions ?? (["allow-once", "deny"] as const);
      lead = `${label}: pending through exec approval (${details.approvalSlug}). Allowed decisions: ${decisions.join(", ")}.`;
      if (decisions.includes("allow-once")) {
        lead += " Approve once to create the bundle; do not use allow-all for exports.";
      }
      output = buildExecApprovalPendingReplyPayload({
        ...details,
        allowedDecisions: decisions,
      }).text;
      break;
    }
    case "approval-unavailable":
      lead = `${label}: approval is unavailable; approval and execution are not confirmed.`;
      output = buildExecApprovalUnavailableReplyPayload(details).text;
      break;
    case "running":
      lead = `${label} is running (exec session ${details.sessionId}).`;
      output = details.tail;
      break;
    case "completed":
      lead = `${label} completed (exit code ${details.exitCode ?? "unknown"}).`;
      output = details.aggregated;
      break;
    case "failed":
      switch (details.reason) {
        case "not-dispatched":
          lead = `${label} was not dispatched.`;
          break;
        case "outcome-unknown":
          lead = `${label} outcome is unknown; check before rerunning.`;
          break;
        case "policy-denied":
          lead = `${label} was denied by policy.`;
          break;
        case undefined:
          lead = `${label} failed (exit code ${details.exitCode ?? "unknown"}).`;
          break;
      }
      output = details.aggregated;
      break;
    case undefined:
      lead = `${label}: approval and execution could not be confirmed; check before rerunning.`;
      output = result.content
        ?.filter((chunk) => chunk.type === "text")
        .map((chunk) => chunk.text ?? "")
        .join("\n");
      break;
  }
  const boundedOutput = sliceUtf16Safe(output?.trim() ?? "", 0, 4_000);
  return boundedOutput ? `${lead}\n\n${boundedOutput}` : lead;
}

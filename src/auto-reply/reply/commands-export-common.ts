/** Shared export-command parsing and target session resolution helpers. */
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    const sessionFile = resolveSessionFilePath(
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

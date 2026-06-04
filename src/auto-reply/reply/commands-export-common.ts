/** Shared export-command parsing and target session resolution helpers. */
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";

/** Resolved session entry and transcript file targeted by an export command. */
export interface ExportCommandSessionTarget {
  entry: SessionEntry;
  sessionFile: string;
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
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(targetAgentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[params.sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { text: `❌ Session not found: ${params.sessionKey}` };
  }

  try {
    const sessionFile = resolveSessionFilePath(
      entry.sessionId,
      entry,
      resolveSessionFilePathOptions({ agentId: targetAgentId, storePath }),
    );
    return { entry, sessionFile };
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

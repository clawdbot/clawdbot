import fs from "node:fs/promises";

import { repairToolUseResultPairing } from "../session-transcript-repair.js";
import { logDebug, logWarn } from "../../logger.js";

type SessionHeaderEntry = { type: "session"; id?: string; cwd?: string };
type SessionMessageEntry = { type: "message"; message?: { role?: string } };

/**
 * pi-coding-agent SessionManager persistence quirk:
 * - If the file exists but has no assistant message, SessionManager marks itself `flushed=true`
 *   and will never persist the initial user message.
 * - If the file doesn't exist yet, SessionManager builds a new session in memory and flushes
 *   header+user+assistant once the first assistant arrives (good).
 *
 * This normalizes the file/session state so the first user prompt is persisted before the first
 * assistant entry, even for pre-created session files.
 */
export async function prepareSessionManagerForRun(params: {
  sessionManager: unknown;
  sessionFile: string;
  hadSessionFile: boolean;
  sessionId: string;
  cwd: string;
}): Promise<void> {
  const sm = params.sessionManager as {
    sessionId: string;
    flushed: boolean;
    fileEntries: Array<SessionHeaderEntry | SessionMessageEntry | { type: string }>;
    byId?: Map<string, unknown>;
    labelsById?: Map<string, unknown>;
    leafId?: string | null;
  };

  const header = sm.fileEntries.find((e): e is SessionHeaderEntry => e.type === "session");
  const hasAssistant = sm.fileEntries.some(
    (e) => e.type === "message" && (e as SessionMessageEntry).message?.role === "assistant",
  );

  if (!params.hadSessionFile && header) {
    header.id = params.sessionId;
    header.cwd = params.cwd;
    sm.sessionId = params.sessionId;
    return;
  }

  if (params.hadSessionFile && header && !hasAssistant) {
    // Reset file so the first assistant flush includes header+user+assistant in order.
    await fs.writeFile(params.sessionFile, "", "utf-8");
    sm.fileEntries = [header];
    sm.byId?.clear?.();
    sm.labelsById?.clear?.();
    sm.leafId = null;
    sm.flushed = false;
  }

  // Repair any unpaired tool calls (e.g., from crashed/timed-out sessions).
  // This prevents sessions from getting stuck when tool calls never received results.
  if (params.hadSessionFile && hasAssistant) {
    repairSessionToolPairing(sm, params.sessionFile);
  }
}

/**
 * Repair unpaired tool calls in a loaded session by injecting synthetic error results.
 * This handles cases where:
 * - A tool execution timed out or crashed before returning
 * - The session was interrupted mid-execution
 * - Tool results were lost due to storage issues
 */
function repairSessionToolPairing(
  sm: {
    fileEntries: Array<SessionHeaderEntry | SessionMessageEntry | { type: string }>;
    flushed: boolean;
  },
  sessionFile: string,
): void {
  // Extract messages from fileEntries
  const messages = sm.fileEntries
    .filter((e): e is SessionMessageEntry => e.type === "message")
    .map((e) => e.message)
    .filter((m): m is NonNullable<typeof m> => m != null);

  if (messages.length === 0) return;

  const report = repairToolUseResultPairing(messages as any);

  if (
    report.added.length > 0 ||
    report.droppedDuplicateCount > 0 ||
    report.droppedOrphanCount > 0
  ) {
    logWarn(
      `Repaired session transcript: file=${sessionFile} ` +
        `added=${report.added.length} droppedDuplicates=${report.droppedDuplicateCount} ` +
        `droppedOrphans=${report.droppedOrphanCount}`,
    );

    // Rebuild fileEntries with repaired messages (nonMessages includes header)
    const nonMessages = sm.fileEntries.filter((e) => e.type !== "message");

    sm.fileEntries = [
      ...nonMessages,
      ...report.messages.map((msg) => ({ type: "message" as const, message: msg })),
    ];

    // Mark as unflushed so the repairs get persisted
    sm.flushed = false;

    logDebug(
      `Session repair details: added synthetic results for tool calls: ${report.added.map((r) => (r as any).toolCallId).join(", ")}`,
    );
  }
}

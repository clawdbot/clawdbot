/** Doctor repair for main sessions accidentally occupied by synthetic heartbeat transcripts. */
import fs from "node:fs";
import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { note } from "../../packages/terminal-core/src/note.js";
import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import {
  resolveSessionFilePath,
  type resolveSessionFilePathOptions,
} from "../config/sessions/paths.js";
import { updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { clearTuiLastSessionPointers } from "../tui/tui-last-session.js";

type DoctorPrompterLike = {
  confirmRuntimeRepair: (params: {
    message: string;
    initialValue?: boolean;
    requiresInteractiveConfirmation?: boolean;
  }) => Promise<boolean>;
  note?: typeof note;
};

type TranscriptHeartbeatSummary = {
  inspectedMessages: number;
  userMessages: number;
  heartbeatUserMessages: number;
  nonHeartbeatUserMessages: number;
  assistantMessages: number;
  heartbeatOkAssistantMessages: number;
};

type HeartbeatMainSessionRepairCandidate = {
  reason: "metadata" | "transcript";
  summary?: TranscriptHeartbeatSummary;
};

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function sessionEntryHasSyntheticHeartbeatOwnership(entry: SessionEntry): boolean {
  return (
    typeof entry.heartbeatIsolatedBaseSessionKey === "string" &&
    entry.heartbeatIsolatedBaseSessionKey.trim().length > 0
  );
}

function parseTranscriptMessageLine(line: string): { role: string; content?: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asNullableObjectRecord(parsed);
  if (!record) {
    return null;
  }
  const nested = asNullableObjectRecord(record.message);
  const message = nested ?? record;
  const role = message.role;
  if (typeof role !== "string") {
    return null;
  }
  return { role, content: message.content };
}

function summarizeTranscriptHeartbeatMessages(
  transcriptPath: string,
): TranscriptHeartbeatSummary | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const summary: TranscriptHeartbeatSummary = {
    inspectedMessages: 0,
    userMessages: 0,
    heartbeatUserMessages: 0,
    nonHeartbeatUserMessages: 0,
    assistantMessages: 0,
    heartbeatOkAssistantMessages: 0,
  };
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const message = parseTranscriptMessageLine(trimmed);
    if (!message) {
      continue;
    }
    summary.inspectedMessages += 1;
    if (message.role === "user") {
      summary.userMessages += 1;
      if (isHeartbeatUserMessage(message)) {
        summary.heartbeatUserMessages += 1;
      } else {
        summary.nonHeartbeatUserMessages += 1;
      }
    } else if (message.role === "assistant") {
      summary.assistantMessages += 1;
      if (isHeartbeatOkResponse(message)) {
        summary.heartbeatOkAssistantMessages += 1;
      }
    }
  }
  return summary.inspectedMessages > 0 ? summary : null;
}

/**
 * Detects main-session entries that are safe to archive because they only contain heartbeat turns.
 *
 * Metadata ownership is preferred, but transcript inspection catches older stores that lack the
 * heartbeat isolation marker while still containing no human user messages.
 */
function resolveHeartbeatMainSessionRepairCandidate(params: {
  entry: SessionEntry | undefined;
  transcriptPath?: string;
}): HeartbeatMainSessionRepairCandidate | null {
  const { entry, transcriptPath } = params;
  if (!entry) {
    return null;
  }
  const hasNoRecordedHumanInteraction = entry.lastInteractionAt === undefined;
  if (!hasNoRecordedHumanInteraction) {
    return null;
  }
  const hasSyntheticHeartbeatOwnership = sessionEntryHasSyntheticHeartbeatOwnership(entry);
  if (hasSyntheticHeartbeatOwnership && !transcriptPath) {
    return { reason: "metadata" };
  }
  if (!transcriptPath) {
    return null;
  }
  const summary = summarizeTranscriptHeartbeatMessages(transcriptPath);
  if (!summary) {
    return null;
  }
  if (
    summary.heartbeatUserMessages > 0 &&
    summary.userMessages === summary.heartbeatUserMessages &&
    summary.nonHeartbeatUserMessages === 0
  ) {
    // A human message must block repair; moving a real conversation would break resume semantics.
    return { reason: hasSyntheticHeartbeatOwnership ? "metadata" : "transcript", summary };
  }
  return null;
}

function resolveHeartbeatMainRecoveryKey(params: {
  mainKey: string;
  store: Record<string, SessionEntry>;
  nowMs?: number;
}): string | null {
  const parsed = parseAgentSessionKey(params.mainKey);
  if (!parsed) {
    return null;
  }
  const stamp = formatSessionArchiveTimestamp(params.nowMs).toLowerCase();
  const base = `agent:${parsed.agentId}:heartbeat-recovered-${stamp}`;
  if (!params.store[base]) {
    return base;
  }
  for (let index = 2; index <= 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!params.store[candidate]) {
      return candidate;
    }
  }
  return null;
}

/** Moves a poisoned main-session entry to a recovery key without overwriting existing entries. */
function moveHeartbeatMainSessionEntry(params: {
  store: Record<string, SessionEntry>;
  mainKey: string;
  recoveredKey: string;
}): boolean {
  const entry = params.store[params.mainKey];
  if (!entry || params.store[params.recoveredKey]) {
    return false;
  }
  params.store[params.recoveredKey] = entry;
  delete params.store[params.mainKey];
  return true;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorHeartbeatMainSessionRepairTestApi")
  ] = {
    moveHeartbeatMainSessionEntry,
    resolveHeartbeatMainSessionRepairCandidate,
  };
}

/**
 * Prompts to archive a heartbeat-owned main session and clears stale TUI restore state.
 *
 * The session store is rechecked inside the update transaction so concurrent session activity
 * prevents moving a newly-human main session.
 */
export async function repairHeartbeatPoisonedMainSession(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  absoluteStorePath: string;
  stateDir: string;
  sessionPathOpts: ReturnType<typeof resolveSessionFilePathOptions>;
  prompter: DoctorPrompterLike;
  warnings: string[];
  changes: string[];
}) {
  const mainKey = resolveMainSessionKey(params.cfg);
  const mainEntry = params.store[mainKey];
  if (!mainEntry?.sessionId) {
    return;
  }
  let transcriptPath: string | undefined;
  try {
    transcriptPath = resolveSessionFilePath(mainEntry.sessionId, mainEntry, params.sessionPathOpts);
  } catch {
    transcriptPath = undefined;
  }
  const candidate = resolveHeartbeatMainSessionRepairCandidate({
    entry: mainEntry,
    transcriptPath,
  });
  if (!candidate) {
    return;
  }
  const recoveredKey = resolveHeartbeatMainRecoveryKey({
    mainKey,
    store: params.store,
  });
  if (!recoveredKey) {
    params.warnings.push(
      `- Main session ${mainKey} appears heartbeat-owned, but doctor could not choose a safe recovery key.`,
    );
    return;
  }
  const reason =
    candidate.reason === "metadata"
      ? "heartbeat metadata"
      : `${candidate.summary?.heartbeatUserMessages ?? 0} heartbeat-only user message(s)`;
  params.warnings.push(
    [
      `- Main session ${mainKey} appears to be a heartbeat-owned session (${reason}).`,
      `  Doctor can move it to ${recoveredKey} and let the next interactive launch create a fresh main session.`,
    ].join("\n"),
  );
  const shouldRepair = await params.prompter.confirmRuntimeRepair({
    message: `Move heartbeat-owned main session ${mainKey} to ${recoveredKey} and clear stale TUI restore pointers?`,
    initialValue: true,
  });
  if (!shouldRepair) {
    return;
  }
  let movedEntry: SessionEntry | undefined;
  await updateSessionStore(params.absoluteStorePath, (currentStore) => {
    const currentEntry = currentStore[mainKey];
    const currentCandidate = resolveHeartbeatMainSessionRepairCandidate({
      entry: currentEntry,
      transcriptPath,
    });
    if (!currentCandidate) {
      return;
    }
    if (moveHeartbeatMainSessionEntry({ store: currentStore, mainKey, recoveredKey })) {
      movedEntry = currentEntry;
    }
  });
  if (!movedEntry) {
    params.warnings.push(`- Main session ${mainKey} changed before repair could move it.`);
    return;
  }
  params.store[recoveredKey] = movedEntry;
  delete params.store[mainKey];
  let clearedPointers = 0;
  try {
    clearedPointers = clearTuiLastSessionPointers({
      stateDir: params.stateDir,
      sessionKeys: new Set([mainKey]),
    });
  } catch (error) {
    params.warnings.push(
      `- Moved heartbeat-owned main session ${mainKey}, but could not clear its TUI restore pointers: ${String(error)}`,
    );
  }
  params.changes.push(`- Moved heartbeat-owned main session ${mainKey} to ${recoveredKey}.`);
  if (clearedPointers > 0) {
    params.changes.push(
      `- Cleared ${countLabel(clearedPointers, "stale TUI last-session pointer")} for ${mainKey}.`,
    );
  }
}

import fs from "node:fs";
import path from "node:path";
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
import { asNullableObjectRecord } from "../shared/record-coerce.js";
import type { note } from "../terminal/note.js";

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

export type HeartbeatMainSessionRepairCandidate = {
  reason: "metadata" | "transcript";
  summary?: TranscriptHeartbeatSummary;
};

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function existsFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
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

export function resolveHeartbeatMainSessionRepairCandidate(params: {
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

export function moveHeartbeatMainSessionEntry(params: {
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

function resolveTuiLastSessionPath(stateDir: string): string {
  return path.join(stateDir, "tui", "last-session.json");
}

export function clearTuiLastSessionPointers(params: {
  filePath: string;
  sessionKeys: ReadonlySet<string>;
}): number {
  if (params.sessionKeys.size === 0 || !existsFile(params.filePath)) {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(params.filePath, "utf8"));
  } catch {
    return 0;
  }
  const store = asNullableObjectRecord(parsed);
  if (!store) {
    return 0;
  }
  let removed = 0;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(store)) {
    const record = asNullableObjectRecord(value);
    const sessionKey = record?.sessionKey;
    if (typeof sessionKey === "string" && params.sessionKeys.has(sessionKey)) {
      removed += 1;
      continue;
    }
    next[key] = value;
  }
  if (removed === 0) {
    return 0;
  }
  try {
    fs.writeFileSync(params.filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    return 0;
  }
  return removed;
}

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
  const clearedPointers = clearTuiLastSessionPointers({
    filePath: resolveTuiLastSessionPath(params.stateDir),
    sessionKeys: new Set([mainKey]),
  });
  params.changes.push(`- Moved heartbeat-owned main session ${mainKey} to ${recoveredKey}.`);
  if (clearedPointers > 0) {
    params.changes.push(
      `- Cleared ${countLabel(clearedPointers, "stale TUI last-session pointer")} for ${mainKey}.`,
    );
  }
}

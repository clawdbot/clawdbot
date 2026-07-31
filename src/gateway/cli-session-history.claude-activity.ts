import { parseCliReseedPrompt } from "../agents/cli-runner/reseed-envelope.js";
import { INTER_SESSION_PROMPT_PREFIX_BASE } from "../sessions/input-provenance.js";
import {
  parseClaudeCliHistoryEntry,
  resolveClaudeCliPromptTextCandidates,
  resolveClaudeCliTimestampMs,
  type ClaudeCliProjectEntry,
} from "./cli-session-history.claude.js";

export type ClaudeCliHistoryLineClassification = {
  humanTurn: boolean;
  occurredAt?: number;
  userText?: string;
};

function classifyClaudeCliHistoryEntry(params: {
  entry: ClaudeCliProjectEntry;
  cliSessionId: string;
  sourceLineNumber: number;
}): ClaudeCliHistoryLineClassification {
  const entry = params.entry;
  const content = entry.message?.content;
  if (entry.type !== "user" || entry.message?.role !== "user") {
    return { humanTurn: false };
  }
  if (typeof content !== "string" && !Array.isArray(content)) {
    return { humanTurn: false };
  }
  const candidates = resolveClaudeCliPromptTextCandidates(entry, content);
  if (
    candidates.length === 0 ||
    candidates.some(
      ({ text }) =>
        text.startsWith(INTER_SESSION_PROMPT_PREFIX_BASE) ||
        parseCliReseedPrompt(text).kind !== "none",
    )
  ) {
    return { humanTurn: false };
  }
  const parsed = parseClaudeCliHistoryEntry(
    entry,
    params.cliSessionId,
    params.sourceLineNumber,
    new Map(),
    { reseedMode: "preserve" },
  );
  if (parsed?.role !== "user") {
    return { humanTurn: false };
  }
  const occurredAt = resolveClaudeCliTimestampMs(entry.timestamp);
  return {
    humanTurn: true,
    userText: candidates[0]?.text,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

/** Classifies one native JSONL row through the same filters used by history import. */
export function classifyClaudeCliHistoryLine(params: {
  line: string;
  cliSessionId: string;
  sourceLineNumber: number;
}): ClaudeCliHistoryLineClassification {
  let entry: ClaudeCliProjectEntry;
  try {
    entry = JSON.parse(params.line) as ClaudeCliProjectEntry;
  } catch {
    return { humanTurn: false };
  }
  return classifyClaudeCliHistoryEntry({ ...params, entry });
}

/** Applies native history filters to an already-decoded catalog user message. */
export function classifyClaudeCliHistoryMessage(params: {
  content: unknown;
  timestamp?: unknown;
  cliSessionId: string;
  sourceLineNumber: number;
}): ClaudeCliHistoryLineClassification {
  return classifyClaudeCliHistoryEntry({
    cliSessionId: params.cliSessionId,
    sourceLineNumber: params.sourceLineNumber,
    entry: {
      type: "user",
      timestamp: params.timestamp,
      message: { role: "user", content: params.content },
    },
  });
}

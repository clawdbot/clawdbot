/**
 * Structured resume contract for runtime-only continuation turns.
 *
 * Compaction and other runtime events can resume with an empty transcript
 * prompt ("Continue the OpenClaw runtime event."). When an interrupted user
 * task is still open, exact NO_REPLY must not close the turn.
 */
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";

export type RuntimeResumeContract = {
  /** True when an unfinished user-facing task is still owed. */
  open: boolean;
  originatingSessionHint?: string;
  requestedOutcome?: string;
  completionGate?: string;
  deliverables: string[];
  blockerState?: string;
  /** Matched heuristic markers (for tests/debug). */
  signals: string[];
};

const RUNTIME_RESUME_CONTINUATION_DIRECTIVE = [
  "Runtime resume directive:",
  "- Resume the interrupted user task from the runtime context below.",
  "- Checkpoint-only work (memory writes, status notes) is not completion.",
  "- Do not return exact NO_REPLY or an empty final while the resume contract is open.",
  "- Either execute the completion gate / produce deliverables, or state a concrete blocker.",
].join("\n");

export const RUNTIME_RESUME_SILENT_REPLY_BLOCKED_TEXT =
  "⚠️ Runtime resume contract is still open. Exact NO_REPLY is not allowed until the requested deliverable is produced or a concrete blocker is reported.";

const OPEN_SIGNAL_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "clcr-open", re: /\bCLCR\s*:\s*open\b/i },
  { id: "packet-not-started", re: /\bpacket\s+not\s+started\b/i },
  { id: "next-turn-must-build", re: /\bnext\s+turn\s+must\s+build\b/i },
  { id: "must-build", re: /\bmust\s+build\b/i },
  { id: "outline-approved-unbuilt", re: /\boutline\s+approved\b/i },
  {
    id: "deliverable-pending",
    re: /\bdeliverable[s]?\s+(?:still\s+)?(?:pending|unbuilt|missing)\b/i,
  },
  { id: "unbuilt", re: /\bunbuilt\b/i },
  { id: "do-it-approval", re: /\bdo\s+it\.?\b/i },
  { id: "approved-build", re: /\bapproved\b.{0,80}\b(?:build|pdf|excel|xlsx|artifact)\b/i },
  { id: "completion-gate-open", re: /\bcompletion\s+gate\b.{0,40}\bopen\b/i },
  { id: "task-incomplete", re: /\b(?:task|work)\s+(?:still\s+)?(?:incomplete|unfinished|open)\b/i },
];

const CLOSED_SIGNAL_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "clcr-closed", re: /\bCLCR\s*:\s*(?:closed|done|complete)\b/i },
  {
    id: "task-complete",
    re: /\b(?:task|deliverable[s]?)\s+(?:complete|completed|delivered|done)\b/i,
  },
  { id: "no-pending-task", re: /\bno\s+pending\s+(?:user\s+)?task\b/i },
];

const SESSION_HINT_RE = /(?:session(?:Key|Id)?|session\s+file)\s*[:=]\s*([^\s,;`"'<>]+)/i;
const OUTCOME_RE =
  /(?:requested\s+outcome|objective|user\s+asked|approved)\s*[:=-]?\s*([^\n]{8,200})/i;
const COMPLETION_GATE_RE =
  /(?:completion\s+gate|done\s+when|success\s+criteria)\s*[:=-]?\s*([^\n]{8,200})/i;
const BLOCKER_RE = /(?:blocker|blocked\s+on|waiting\s+on)\s*[:=-]?\s*([^\n]{8,200})/i;
const DELIVERABLE_RE = /\b((?:pdf|excel|xlsx|docx|csv|artifact|report|packet)[^\n,;]{0,80})/gi;

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Derive a resume contract from free-form runtime context prose. */
export function extractRuntimeResumeContract(
  runtimeContext: string | undefined | null,
): RuntimeResumeContract {
  const text = runtimeContext?.trim() ?? "";
  if (!text) {
    return { open: false, deliverables: [], signals: [] };
  }

  const signals: string[] = [];
  for (const pattern of OPEN_SIGNAL_PATTERNS) {
    if (pattern.re.test(text)) {
      signals.push(pattern.id);
    }
  }
  const closedSignals: string[] = [];
  for (const pattern of CLOSED_SIGNAL_PATTERNS) {
    if (pattern.re.test(text)) {
      closedSignals.push(pattern.id);
    }
  }

  const deliverables = uniqueNonEmpty(
    Array.from(text.matchAll(DELIVERABLE_RE), (match) => match[1]?.trim()),
  ).slice(0, 8);

  const originatingSessionHint = text.match(SESSION_HINT_RE)?.[1]?.trim();
  const requestedOutcome = text.match(OUTCOME_RE)?.[1]?.trim();
  const completionGate = text.match(COMPLETION_GATE_RE)?.[1]?.trim();
  const blockerState = text.match(BLOCKER_RE)?.[1]?.trim();

  // Explicit closed markers win when no open markers remain strong.
  const open =
    signals.length > 0 &&
    !(closedSignals.includes("clcr-closed") || closedSignals.includes("no-pending-task"));

  return {
    open,
    ...(originatingSessionHint ? { originatingSessionHint } : {}),
    ...(requestedOutcome ? { requestedOutcome } : {}),
    ...(completionGate
      ? { completionGate }
      : open
        ? {
            completionGate:
              "Produce the approved deliverable(s) or report a concrete blocker. Memory checkpoint alone is insufficient.",
          }
        : {}),
    deliverables,
    ...(blockerState ? { blockerState } : {}),
    signals: [...signals, ...closedSignals.map((id) => `closed:${id}`)],
  };
}

/** Appended to runtime-event system context when a resume contract is open. */
export function formatRuntimeResumeSystemAppendix(contract: RuntimeResumeContract): string {
  if (!contract.open) {
    return "";
  }
  const payload = {
    open: true,
    originatingSessionHint: contract.originatingSessionHint,
    requestedOutcome: contract.requestedOutcome,
    completionGate: contract.completionGate,
    deliverables: contract.deliverables,
    blockerState: contract.blockerState,
    signals: contract.signals,
  };
  return [
    RUNTIME_RESUME_CONTINUATION_DIRECTIVE,
    "",
    "Structured resume contract (authoritative):",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

/** Runtime-only turns with an open resume contract must not accept exact silence. */
export function shouldBlockSilentReplyOnRuntimeResume(params: {
  runtimeOnly?: boolean;
  resumeContract?: RuntimeResumeContract | null;
  blockRuntimeResumeSilentReply?: boolean;
}): boolean {
  if (params.blockRuntimeResumeSilentReply === true) {
    return true;
  }
  return params.runtimeOnly === true && params.resumeContract?.open === true;
}

export function isBlockedRuntimeResumeSilentReply(params: {
  runtimeOnly?: boolean;
  resumeContract?: RuntimeResumeContract | null;
  blockRuntimeResumeSilentReply?: boolean;
  assistantTexts?: readonly string[];
}): boolean {
  if (!shouldBlockSilentReplyOnRuntimeResume(params)) {
    return false;
  }
  const texts = (params.assistantTexts ?? []).map((text) => text.trim()).filter(Boolean);
  if (texts.length === 0) {
    return true;
  }
  return texts.every((text) => isSilentReplyPayloadText(text, SILENT_REPLY_TOKEN));
}

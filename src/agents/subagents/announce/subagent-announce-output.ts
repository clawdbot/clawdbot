/**
 * Subagent completion output capture.
 *
 * Reads child session output, detects waiting states, and formats completion findings for announcements.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import { resolveFreshSessionTotalTokens } from "../../../config/sessions/types.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
import {
  buildAgentRunTerminalOutcomeFromWaitResult,
  classifyAgentRunTerminalOutcome,
} from "../../agent-run-terminal-outcome.js";
import { wrapPromptDataBlock } from "../../sanitize-for-prompt.js";
import { extractStoredAssistantText, sanitizeTextContent } from "../../tools/chat-history-text.js";
import {
  isAnnounceSkip,
  selectDeliverableSessionsReply,
} from "../../tools/sessions-send-tokens.js";
import { compareSubagentRunGeneration } from "../registry/subagent-run-generation.js";
import {
  captureSubagentCompletionReplyUsing,
  readLatestSubagentOutputWithRetryUsing,
} from "./subagent-announce-capture.js";
import {
  callGateway,
  getRuntimeConfig,
  readSubagentSessionEntry,
  readSessionMessagesAsync,
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "./subagent-announce.runtime.js";
import { assistantCallsSessionsYield, isSessionsYieldToolResult } from "./subagent-yield-output.js";

const FAST_TEST_RETRY_INTERVAL_MS = 8;
const MAX_CHILD_COMPLETION_RESULT_CHARS = 512;
const MAX_CHILD_COMPLETION_FIELD_CHARS = 256;
const MAX_CHILD_COMPLETION_FINDINGS_CHARS = 4_096;
const CHILD_RESULT_TRUNCATION_NOTICE = "\n[child result truncated]";
const ASSISTANT_TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "tool_use",
  "toolUse",
  "functionCall",
  "function_call",
]);
type SubagentAnnounceOutputDeps = {
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  readSubagentSessionEntry: typeof readSubagentSessionEntry;
  readSessionMessagesAsync: typeof readSessionMessagesAsync;
  resolveAgentIdFromSessionKey: typeof resolveAgentIdFromSessionKey;
  resolveSessionStorePathCore: typeof resolveSessionStorePathCore;
};

const defaultSubagentAnnounceOutputDeps: SubagentAnnounceOutputDeps = {
  callGateway,
  getRuntimeConfig,
  readSubagentSessionEntry,
  readSessionMessagesAsync,
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
};

let subagentAnnounceOutputDeps: SubagentAnnounceOutputDeps = defaultSubagentAnnounceOutputDeps;

function isFastTestMode() {
  return isFastTestRuntimeEnv();
}

type SubagentOutputSnapshot = {
  latestAssistantText?: string;
  latestSilentText?: string;
  latestToolCallCount?: number;
  waitingForContinuation?: boolean;
};

type AgentWaitResult = {
  status?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  timeoutPhase?: string;
  providerStarted?: boolean;
};

export type SubagentRunOutcome = {
  status: "ok" | "error" | "timeout" | "unknown";
  error?: string;
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
};

export function withSubagentOutcomeTiming(
  outcome: SubagentRunOutcome,
  timing: {
    startedAt?: number;
    endedAt?: number;
  },
): SubagentRunOutcome {
  const startedAt = asFiniteNumber(timing.startedAt) ?? asFiniteNumber(outcome.startedAt);
  const endedAt = asFiniteNumber(timing.endedAt) ?? asFiniteNumber(outcome.endedAt);
  const nextTiming: Pick<SubagentRunOutcome, "startedAt" | "endedAt" | "elapsedMs"> = {};
  if (typeof startedAt === "number") {
    nextTiming.startedAt = startedAt;
  }
  if (typeof endedAt === "number") {
    nextTiming.endedAt = endedAt;
  }
  if (typeof startedAt === "number" && typeof endedAt === "number") {
    nextTiming.elapsedMs = Math.max(0, endedAt - startedAt);
  }
  return { ...outcome, ...nextTiming };
}

function extractSubagentAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "assistant") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return sanitizeTextContent(content);
  }
  return extractStoredAssistantText(message) ?? "";
}

function countAssistantToolCalls(message: unknown): number {
  if (!message || typeof message !== "object") {
    return 0;
  }
  const content = (message as { content?: unknown }).content;
  const contentToolCalls = Array.isArray(content)
    ? content.filter(
        (block) =>
          block &&
          typeof block === "object" &&
          ASSISTANT_TOOL_CALL_BLOCK_TYPES.has((block as { type?: string }).type ?? ""),
      ).length
    : 0;
  const toolCalls =
    (message as { toolCalls?: unknown; tool_calls?: unknown }).toolCalls ??
    (message as { tool_calls?: unknown }).tool_calls;
  return contentToolCalls + (Array.isArray(toolCalls) ? toolCalls.length : 0);
}

function summarizeSubagentOutputHistory(messages: Array<unknown>): SubagentOutputSnapshot {
  const snapshot: SubagentOutputSnapshot = {};
  let previousAssistantCalledYield = false;
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    const provenance = (message as { provenance?: unknown }).provenance;
    if (
      role === "user" ||
      (provenance &&
        typeof provenance === "object" &&
        !Array.isArray(provenance) &&
        (provenance as { kind?: unknown }).kind === "inter_session")
    ) {
      // A fresh input owns a new turn; never announce an older turn's reply
      // when the current run fails or completes without visible output.
      snapshot.latestAssistantText = undefined;
      snapshot.latestSilentText = undefined;
      snapshot.latestToolCallCount = undefined;
      snapshot.waitingForContinuation = false;
      previousAssistantCalledYield = false;
      continue;
    }
    if (role === "assistant") {
      if (assistantCallsSessionsYield(message)) {
        snapshot.latestAssistantText = undefined;
        snapshot.latestSilentText = undefined;
        snapshot.waitingForContinuation = true;
        previousAssistantCalledYield = true;
        continue;
      }
      const text = extractSubagentAssistantText(message).trim();
      if (!text) {
        snapshot.latestToolCallCount =
          (snapshot.latestToolCallCount ?? 0) + countAssistantToolCalls(message);
        snapshot.waitingForContinuation = false;
        previousAssistantCalledYield = false;
        continue;
      }
      if (isAnnounceSkip(text) || isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
        snapshot.latestSilentText = text;
        snapshot.latestAssistantText = undefined;
        snapshot.waitingForContinuation = false;
        previousAssistantCalledYield = false;
        continue;
      }
      snapshot.latestSilentText = undefined;
      snapshot.latestAssistantText = text;
      snapshot.waitingForContinuation = false;
      previousAssistantCalledYield = false;
      continue;
    }
    if (isSessionsYieldToolResult(message, previousAssistantCalledYield)) {
      snapshot.latestAssistantText = undefined;
      snapshot.latestSilentText = undefined;
      snapshot.waitingForContinuation = true;
      previousAssistantCalledYield = false;
      continue;
    }
    previousAssistantCalledYield = false;
  }
  return snapshot;
}

function selectSubagentOutputText(
  snapshot: SubagentOutputSnapshot,
  outcome?: SubagentRunOutcome,
): string | undefined {
  if (snapshot.waitingForContinuation) {
    return undefined;
  }
  if (snapshot.latestSilentText) {
    return snapshot.latestSilentText;
  }
  if (snapshot.latestAssistantText) {
    return snapshot.latestAssistantText;
  }
  // Tool activity is partial-progress evidence only for a timed-out run. It is
  // not authoritative completion output when producer terminal facts are absent.
  if (
    outcome?.status === "timeout" &&
    snapshot.latestToolCallCount &&
    snapshot.latestToolCallCount > 0
  ) {
    return `${snapshot.latestToolCallCount} tool call(s) made without visible output.`;
  }
  return undefined;
}

export async function readSubagentOutput(
  sessionKey: string,
  outcome?: SubagentRunOutcome,
  options?: { sessionTarget?: SessionTranscriptRuntimeTarget },
): Promise<string | undefined> {
  let messages: unknown[] | undefined;
  if (options?.sessionTarget) {
    const transcriptMessages = await subagentAnnounceOutputDeps.readSessionMessagesAsync(
      options.sessionTarget,
      {
        mode: "recent",
        maxMessages: 100,
        maxBytes: 1024 * 1024,
      },
    );
    messages = transcriptMessages;
  }
  const history =
    messages === undefined
      ? await subagentAnnounceOutputDeps.callGateway({
          method: "chat.history",
          params: { sessionKey, limit: 100 },
        })
      : undefined;
  const sourceMessages = messages ?? (Array.isArray(history?.messages) ? history.messages : []);
  const snapshot = summarizeSubagentOutputHistory(sourceMessages);
  const selected = selectSubagentOutputText(snapshot, outcome);
  if (selected?.trim()) {
    return selected;
  }
  return undefined;
}

export async function readLatestSubagentOutputWithRetry(params: {
  sessionKey: string;
  maxWaitMs: number;
  outcome?: SubagentRunOutcome;
}): Promise<string | undefined> {
  return await readLatestSubagentOutputWithRetryUsing({
    sessionKey: params.sessionKey,
    maxWaitMs: params.maxWaitMs,
    outcome: params.outcome,
    retryIntervalMs: isFastTestMode() ? FAST_TEST_RETRY_INTERVAL_MS : 100,
    readSubagentOutput,
  });
}

export async function readSubagentTimeoutProgress(
  sessionKey: string,
  maxWaitMs: number,
  outcome: SubagentRunOutcome,
): Promise<string | undefined> {
  const initial = await readSubagentOutput(sessionKey, outcome);
  const progress = initial?.trim()
    ? initial
    : await readLatestSubagentOutputWithRetry({ sessionKey, maxWaitMs, outcome });
  return progress && !isAnnounceSkip(progress) && !isSilentReplyText(progress, SILENT_REPLY_TOKEN)
    ? progress
    : undefined;
}

export async function waitForSubagentRunOutcome(
  runId: string,
  timeoutMs: number,
): Promise<AgentWaitResult> {
  const waitMs = Math.max(0, Math.floor(timeoutMs));
  return await subagentAnnounceOutputDeps.callGateway({
    method: "agent.wait",
    params: {
      runId,
      timeoutMs: waitMs,
    },
    timeoutMs: waitMs + 2000,
  });
}

export function applySubagentWaitOutcome(params: {
  wait: AgentWaitResult | undefined;
  outcome: SubagentRunOutcome | undefined;
  startedAt?: number;
  endedAt?: number;
}) {
  const next = {
    outcome: params.outcome,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
  };
  if (typeof params.wait?.startedAt === "number" && typeof next.startedAt !== "number") {
    next.startedAt = params.wait.startedAt;
  }
  if (typeof params.wait?.endedAt === "number" && typeof next.endedAt !== "number") {
    next.endedAt = params.wait.endedAt;
  }
  const waitError = typeof params.wait?.error === "string" ? params.wait.error : undefined;
  const terminalOutcome = buildAgentRunTerminalOutcomeFromWaitResult(params.wait);
  let outcome = next.outcome;
  // Capture/announcement callers can pass raw wait snapshots that bypass the
  // primary normalizers, so apply the canonical classification here instead
  // of re-enumerating reason groups.
  if (terminalOutcome) {
    switch (classifyAgentRunTerminalOutcome(terminalOutcome)) {
      case "timeout":
        outcome = { status: "timeout" };
        break;
      case "cancellation":
        outcome = { status: "error", error: "subagent run terminated" };
        break;
      case "failure":
        outcome = { status: "error", error: terminalOutcome.error ?? waitError };
        break;
      case "success":
        outcome = { status: "ok" };
        break;
    }
  }
  next.outcome = outcome ? withSubagentOutcomeTiming(outcome, next) : undefined;
  return next;
}

export async function captureSubagentCompletionReply(
  sessionKey: string,
  options?: {
    waitForReply?: boolean;
    outcome?: SubagentRunOutcome;
    sessionTarget?: SessionTranscriptRuntimeTarget;
  },
): Promise<string | undefined> {
  return await captureSubagentCompletionReplyUsing({
    sessionKey,
    waitForReply: options?.waitForReply,
    maxWaitMs: isFastTestMode() ? 50 : 1_500,
    retryIntervalMs: isFastTestMode() ? FAST_TEST_RETRY_INTERVAL_MS : 100,
    readSubagentOutput: async (nextSessionKey) =>
      await readSubagentOutput(nextSessionKey, options?.outcome, {
        sessionTarget: options?.sessionTarget,
      }),
  });
}

function describeSubagentOutcome(outcome?: SubagentRunOutcome): string {
  if (!outcome) {
    return "unknown";
  }
  if (outcome.status === "ok") {
    return "ok";
  }
  if (outcome.status === "timeout") {
    return "timeout";
  }
  if (outcome.status === "error") {
    return outcome.error?.trim() ? `error: ${outcome.error.trim()}` : "error";
  }
  return "unknown";
}

function formatChildResultData(resultText?: string | null): string {
  const text = resultText?.trim() || "(no output)";
  const boundedText =
    text.length > MAX_CHILD_COMPLETION_RESULT_CHARS
      ? `${truncateUtf16Safe(
          text,
          MAX_CHILD_COMPLETION_RESULT_CHARS - CHILD_RESULT_TRUNCATION_NOTICE.length,
        )}${CHILD_RESULT_TRUNCATION_NOTICE}`
      : text;
  return (
    wrapPromptDataBlock({
      label: "Child result",
      text: boundedText,
      maxChars: MAX_CHILD_COMPLETION_RESULT_CHARS,
    }) || "Child result: (no output)"
  );
}

function truncateChildCompletionField(value: string): string {
  return value.length > MAX_CHILD_COMPLETION_FIELD_CHARS
    ? `${truncateUtf16Safe(value, MAX_CHILD_COMPLETION_FIELD_CHARS - 1)}…`
    : value;
}

type ChildCompletionExecution = { endedAt?: number; outcome?: SubagentRunOutcome };

type ChildCompletionRow = {
  childSessionKey: string;
  task: string;
  label?: string;
  createdAt: number;
  execution: ChildCompletionExecution;
  frozenResultText?: string | null;
  completion?: {
    resultText?: string | null;
    fallbackResultText?: string | null;
  };
};

type ChildCompletionSection = {
  index: number;
  text: string;
  actionable: boolean;
};

function selectChildCompletionResultText(child: ChildCompletionRow): string | undefined {
  const primary = child.completion?.resultText;
  const fallback = child.completion?.fallbackResultText ?? child.frozenResultText;
  if (child.execution.outcome?.status === "ok") {
    return selectDeliverableSessionsReply(primary, fallback);
  }
  return (primary ?? fallback)?.trim() || undefined;
}

function hasCapturedChildCompletionReply(child: ChildCompletionRow): boolean {
  return [
    child.completion?.resultText,
    child.completion?.fallbackResultText,
    child.frozenResultText,
  ].some((value) => Boolean(value?.trim()));
}

export function buildChildCompletionFindings(
  children: Array<ChildCompletionRow>,
): string | undefined {
  const sorted = [...children].toSorted((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    const aEnded =
      typeof a.execution.endedAt === "number" ? a.execution.endedAt : Number.MAX_SAFE_INTEGER;
    const bEnded =
      typeof b.execution.endedAt === "number" ? b.execution.endedAt : Number.MAX_SAFE_INTEGER;
    if (aEnded !== bEnded) {
      return aEnded - bEnded;
    }
    // Parallel children commonly share millisecond timestamps; their stable
    // session identity keeps parent-visible findings and prompt bytes ordered.
    return a.childSessionKey < b.childSessionKey
      ? -1
      : a.childSessionKey > b.childSessionKey
        ? 1
        : 0;
  });

  const sections: ChildCompletionSection[] = [];
  for (const [index, child] of sorted.entries()) {
    const resultText = selectChildCompletionResultText(child);
    const outcome = describeSubagentOutcome(child.execution.outcome);
    if (
      child.execution.outcome?.status === "ok" &&
      !resultText &&
      hasCapturedChildCompletionReply(child)
    ) {
      continue;
    }
    const title =
      child.label?.trim() ||
      child.task.trim() ||
      child.childSessionKey.trim() ||
      `child ${index + 1}`;
    const displayIndex = sections.length + 1;
    sections.push({
      index: displayIndex,
      actionable: child.execution.outcome?.status !== "ok",
      text: [
        `${displayIndex}. ${truncateChildCompletionField(title)}`,
        `status: ${truncateChildCompletionField(outcome)}`,
        formatChildResultData(resultText),
      ].join("\n"),
    });
  }

  if (sections.length === 0) {
    return undefined;
  }

  // Escaping can expand bounded child text. Preserve failures before successes,
  // keep rendered survivors chronological, and account for omitted completions.
  const render = (visibleSections: string[], omittedCount = 0) =>
    [
      "Child completion results:",
      "",
      ...visibleSections,
      ...(omittedCount > 0
        ? [
            `[${omittedCount} additional child completion result${omittedCount === 1 ? "" : "s"} omitted to fit the context budget.]`,
          ]
        : []),
    ].join("\n\n");
  const allSections = sections.map((section) => section.text);
  if (render(allSections).length <= MAX_CHILD_COMPLETION_FINDINGS_CHARS) {
    return render(allSections);
  }
  const prioritizedSections = [
    ...sections.filter((section) => section.actionable),
    ...sections.filter((section) => !section.actionable),
  ];
  let visibleSections: ChildCompletionSection[] = [];
  for (const section of prioritizedSections) {
    const nextSections = [...visibleSections, section].toSorted(
      (left, right) => left.index - right.index,
    );
    const omittedCount = sections.length - nextSections.length;
    if (
      render(
        nextSections.map((entry) => entry.text),
        omittedCount,
      ).length <= MAX_CHILD_COMPLETION_FINDINGS_CHARS
    ) {
      visibleSections = nextSections;
    }
  }
  return render(
    visibleSections.map((section) => section.text),
    sections.length - visibleSections.length,
  );
}

export function dedupeLatestChildCompletionRows(
  children: Array<{
    runId: string;
    childSessionKey: string;
    task: string;
    label?: string;
    generation?: number;
    createdAt: number;
    execution: ChildCompletionExecution;
    frozenResultText?: string | null;
    completion?: {
      resultText?: string | null;
      fallbackResultText?: string | null;
    };
  }>,
) {
  const latestByChildSessionKey = new Map<string, (typeof children)[number]>();
  for (const child of children) {
    const existing = latestByChildSessionKey.get(child.childSessionKey);
    if (!existing || compareSubagentRunGeneration(child, existing) > 0) {
      latestByChildSessionKey.set(child.childSessionKey, child);
    }
  }
  return [...latestByChildSessionKey.values()];
}

export function filterCurrentDirectChildCompletionRows(
  children: Array<{
    runId: string;
    childSessionKey: string;
    requesterSessionKey: string;
    requesterAgentId?: string;
    task: string;
    label?: string;
    createdAt: number;
    execution: ChildCompletionExecution;
    frozenResultText?: string | null;
    completion?: {
      resultText?: string | null;
      fallbackResultText?: string | null;
    };
  }>,
  params: {
    requesterSessionKey: string;
    requesterAgentId?: string;
    getLatestSubagentRunByChildSessionKey?: (childSessionKey: string) =>
      | {
          runId: string;
          requesterSessionKey: string;
          requesterAgentId?: string;
        }
      | null
      | undefined;
  },
) {
  if (typeof params.getLatestSubagentRunByChildSessionKey !== "function") {
    return children;
  }
  return children.filter((child) => {
    const latest = params.getLatestSubagentRunByChildSessionKey?.(child.childSessionKey);
    if (!latest) {
      return true;
    }
    return (
      latest.runId === child.runId &&
      latest.requesterSessionKey === params.requesterSessionKey &&
      (!params.requesterAgentId || latest.requesterAgentId === params.requesterAgentId)
    );
  });
}

function formatTokenCount(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    const formattedThousands = (value / 1_000).toFixed(1);
    // Keep the compact stats unit scheme stable when one-decimal rounding
    // reaches the next unit, e.g. 999_999 -> 1000.0k.
    if (Number(formattedThousands) >= 1_000) {
      return `${(value / 1_000_000).toFixed(1)}m`;
    }
    return `${formattedThousands}k`;
  }
  return String(Math.round(value));
}

export async function buildCompactAnnounceStatsLine(params: {
  sessionKey: string;
  startedAt?: number;
  endedAt?: number;
}) {
  const cfg = subagentAnnounceOutputDeps.getRuntimeConfig();
  const agentId = subagentAnnounceOutputDeps.resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = subagentAnnounceOutputDeps.resolveSessionStorePathCore(cfg.session?.store, {
    agentId,
  });
  let entry = subagentAnnounceOutputDeps.readSubagentSessionEntry(storePath, params.sessionKey);
  const tokenWaitAttempts = isFastTestMode() ? 1 : 3;
  for (let attempt = 0; attempt < tokenWaitAttempts; attempt += 1) {
    const hasTokenData =
      typeof entry?.inputTokens === "number" ||
      typeof entry?.outputTokens === "number" ||
      resolveFreshSessionTotalTokens(entry) !== undefined;
    if (hasTokenData) {
      break;
    }
    if (!isFastTestMode()) {
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
    }
    entry = subagentAnnounceOutputDeps.readSubagentSessionEntry(storePath, params.sessionKey);
  }

  const input = typeof entry?.inputTokens === "number" ? entry.inputTokens : 0;
  const output = typeof entry?.outputTokens === "number" ? entry.outputTokens : 0;
  const ioTotal = input + output;
  const promptCache = resolveFreshSessionTotalTokens(entry);
  const runtimeMs =
    typeof params.startedAt === "number" && typeof params.endedAt === "number"
      ? Math.max(0, params.endedAt - params.startedAt)
      : undefined;

  const parts = [
    `runtime ${formatDurationCompact(runtimeMs) ?? "n/a"}`,
    `tokens ${formatTokenCount(ioTotal)} (in ${formatTokenCount(input)} / out ${formatTokenCount(output)})`,
  ];
  if (typeof promptCache === "number" && promptCache > ioTotal) {
    parts.push(`prompt/cache ${formatTokenCount(promptCache)}`);
  }
  return `Stats: ${parts.join(" • ")}`;
}

const testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceOutputDeps>) {
    subagentAnnounceOutputDeps = overrides
      ? {
          ...defaultSubagentAnnounceOutputDeps,
          ...overrides,
        }
      : defaultSubagentAnnounceOutputDeps;
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentAnnounceOutputTestApi")
  ] = testing;
}

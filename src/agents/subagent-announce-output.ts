/**
 * Subagent completion output capture.
 *
 * Reads child session output, detects waiting states, and formats completion findings for announcements.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "./agent-run-terminal-outcome.js";
import { wrapPromptDataBlock } from "./sanitize-for-prompt.js";
import {
  captureSubagentCompletionReplyUsing,
  readLatestSubagentOutputWithRetryUsing,
} from "./subagent-announce-capture.js";
import {
  callGateway,
  getRuntimeConfig,
  readSessionEntry,
  readSessionMessagesAsync,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
} from "./subagent-announce.runtime.js";
import { assistantCallsSessionsYield, isSessionsYieldToolResult } from "./subagent-yield-output.js";
import { extractAssistantText, sanitizeTextContent } from "./tools/session-message-text.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

const FAST_TEST_RETRY_INTERVAL_MS = 8;

type SubagentAnnounceOutputDeps = {
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  readSessionEntry: typeof readSessionEntry;
  readSessionMessagesAsync: typeof readSessionMessagesAsync;
  resolveAgentIdFromSessionKey: typeof resolveAgentIdFromSessionKey;
  resolveStorePath: typeof resolveStorePath;
};

const defaultSubagentAnnounceOutputDeps: SubagentAnnounceOutputDeps = {
  callGateway,
  getRuntimeConfig,
  readSessionEntry,
  readSessionMessagesAsync,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
};

let subagentAnnounceOutputDeps: SubagentAnnounceOutputDeps = defaultSubagentAnnounceOutputDeps;

function isFastTestMode() {
  return process.env.OPENCLAW_TEST_FAST === "1";
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
  return extractAssistantText(message) ?? "";
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
          ((block as { type?: unknown }).type === "toolCall" ||
            (block as { type?: unknown }).type === "tool_use"),
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

function selectSubagentOutputText(snapshot: SubagentOutputSnapshot): string | undefined {
  if (snapshot.waitingForContinuation) {
    return undefined;
  }
  if (snapshot.latestSilentText) {
    return snapshot.latestSilentText;
  }
  if (snapshot.latestAssistantText) {
    return snapshot.latestAssistantText;
  }
  if (snapshot.latestToolCallCount && snapshot.latestToolCallCount > 0) {
    return `${snapshot.latestToolCallCount} tool call(s) made without visible output.`;
  }
  return undefined;
}

export async function readSubagentOutput(
  sessionKey: string,
  _outcome?: SubagentRunOutcome,
  options?: { sessionFile?: string },
): Promise<string | undefined> {
  let messages: unknown[] | undefined;
  if (options?.sessionFile) {
    const transcriptMessages = await subagentAnnounceOutputDeps.readSessionMessagesAsync(
      sessionKey,
      undefined,
      options.sessionFile,
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
  const selected = selectSubagentOutputText(snapshot);
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
  // primary normalizers, so preserve the shared timeout/cancel precedence here.
  if (terminalOutcome?.status === "timeout") {
    outcome = { status: "timeout" };
  } else if (terminalOutcome?.reason === "aborted" || terminalOutcome?.reason === "cancelled") {
    outcome = { status: "error", error: "subagent run terminated" };
  } else if (terminalOutcome?.reason === "blocked" || terminalOutcome?.reason === "failed") {
    outcome = { status: "error", error: terminalOutcome.error ?? waitError };
  } else if (terminalOutcome?.reason === "completed") {
    outcome = { status: "ok" };
  }
  next.outcome = outcome ? withSubagentOutcomeTiming(outcome, next) : undefined;
  return next;
}

export async function captureSubagentCompletionReply(
  sessionKey: string,
  options?: { waitForReply?: boolean; outcome?: SubagentRunOutcome; sessionFile?: string },
): Promise<string | undefined> {
  return await captureSubagentCompletionReplyUsing({
    sessionKey,
    waitForReply: options?.waitForReply,
    maxWaitMs: isFastTestMode() ? 50 : 1_500,
    retryIntervalMs: isFastTestMode() ? FAST_TEST_RETRY_INTERVAL_MS : 100,
    readSubagentOutput: async (nextSessionKey) =>
      await readSubagentOutput(nextSessionKey, options?.outcome, {
        sessionFile: options?.sessionFile,
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
  return (
    wrapPromptDataBlock({
      label: "Child result",
      text: resultText?.trim() || "(no output)",
    }) || "Child result: (no output)"
  );
}

type ChildCompletionRow = {
  childSessionKey: string;
  task: string;
  label?: string;
  createdAt: number;
  endedAt?: number;
  frozenResultText?: string | null;
  completion?: {
    resultText?: string | null;
    fallbackResultText?: string | null;
  };
  delivery?: {
    payload?: {
      frozenResultText?: string | null;
      fallbackFrozenResultText?: string | null;
    };
  };
  outcome?: SubagentRunOutcome;
};

function selectChildCompletionResultText(child: ChildCompletionRow): string | undefined {
  return (
    child.completion?.resultText ??
    child.delivery?.payload?.frozenResultText ??
    child.completion?.fallbackResultText ??
    child.delivery?.payload?.fallbackFrozenResultText ??
    child.frozenResultText ??
    undefined
  )?.trim();
}

export function buildChildCompletionFindings(
  children: Array<ChildCompletionRow>,
): string | undefined {
  const sorted = [...children].toSorted((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    const aEnded = typeof a.endedAt === "number" ? a.endedAt : Number.MAX_SAFE_INTEGER;
    const bEnded = typeof b.endedAt === "number" ? b.endedAt : Number.MAX_SAFE_INTEGER;
    return aEnded - bEnded;
  });

  const sections: string[] = [];
  for (const [index, child] of sorted.entries()) {
    const resultText = selectChildCompletionResultText(child);
    const outcome = describeSubagentOutcome(child.outcome);
    if (
      child.outcome?.status === "ok" &&
      resultText &&
      (isAnnounceSkip(resultText) || isSilentReplyText(resultText, SILENT_REPLY_TOKEN))
    ) {
      continue;
    }
    const title =
      child.label?.trim() ||
      child.task.trim() ||
      child.childSessionKey.trim() ||
      `child ${index + 1}`;
    const displayIndex = sections.length + 1;
    sections.push(
      [`${displayIndex}. ${title}`, `status: ${outcome}`, formatChildResultData(resultText)].join(
        "\n",
      ),
    );
  }

  if (sections.length === 0) {
    return undefined;
  }

  return ["Child completion results:", "", ...sections].join("\n\n");
}

export function dedupeLatestChildCompletionRows(
  children: Array<{
    childSessionKey: string;
    task: string;
    label?: string;
    createdAt: number;
    endedAt?: number;
    frozenResultText?: string | null;
    completion?: {
      resultText?: string | null;
      fallbackResultText?: string | null;
    };
    delivery?: {
      payload?: {
        frozenResultText?: string | null;
        fallbackFrozenResultText?: string | null;
      };
    };
    outcome?: SubagentRunOutcome;
  }>,
) {
  const latestByChildSessionKey = new Map<string, (typeof children)[number]>();
  for (const child of children) {
    const existing = latestByChildSessionKey.get(child.childSessionKey);
    if (!existing || child.createdAt > existing.createdAt) {
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
    task: string;
    label?: string;
    createdAt: number;
    endedAt?: number;
    frozenResultText?: string | null;
    completion?: {
      resultText?: string | null;
      fallbackResultText?: string | null;
    };
    delivery?: {
      payload?: {
        frozenResultText?: string | null;
        fallbackFrozenResultText?: string | null;
      };
    };
    outcome?: SubagentRunOutcome;
  }>,
  params: {
    requesterSessionKey: string;
    getLatestSubagentRunByChildSessionKey?: (childSessionKey: string) =>
      | {
          runId: string;
          requesterSessionKey: string;
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
      latest.runId === child.runId && latest.requesterSessionKey === params.requesterSessionKey
    );
  });
}

function formatDurationShort(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  const totalSeconds = Math.round(valueMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
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
  const storePath = subagentAnnounceOutputDeps.resolveStorePath(cfg.session?.store, { agentId });
  let entry = subagentAnnounceOutputDeps.readSessionEntry(storePath, params.sessionKey);
  const tokenWaitAttempts = isFastTestMode() ? 1 : 3;
  for (let attempt = 0; attempt < tokenWaitAttempts; attempt += 1) {
    const hasTokenData =
      typeof entry?.inputTokens === "number" ||
      typeof entry?.outputTokens === "number" ||
      typeof entry?.totalTokens === "number";
    if (hasTokenData) {
      break;
    }
    if (!isFastTestMode()) {
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
    }
    entry = subagentAnnounceOutputDeps.readSessionEntry(storePath, params.sessionKey);
  }

  const input = typeof entry?.inputTokens === "number" ? entry.inputTokens : 0;
  const output = typeof entry?.outputTokens === "number" ? entry.outputTokens : 0;
  const ioTotal = input + output;
  const promptCache = typeof entry?.totalTokens === "number" ? entry.totalTokens : undefined;
  const runtimeMs =
    typeof params.startedAt === "number" && typeof params.endedAt === "number"
      ? Math.max(0, params.endedAt - params.startedAt)
      : undefined;

  const parts = [
    `runtime ${formatDurationShort(runtimeMs)}`,
    `tokens ${formatTokenCount(ioTotal)} (in ${formatTokenCount(input)} / out ${formatTokenCount(output)})`,
  ];
  if (typeof promptCache === "number" && promptCache > ioTotal) {
    parts.push(`prompt/cache ${formatTokenCount(promptCache)}`);
  }
  return `Stats: ${parts.join(" • ")}`;
}

export const testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceOutputDeps>) {
    subagentAnnounceOutputDeps = overrides
      ? {
          ...defaultSubagentAnnounceOutputDeps,
          ...overrides,
        }
      : defaultSubagentAnnounceOutputDeps;
  },
};
export { testing as __testing };

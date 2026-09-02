// Qa Lab plugin module implements suite runtime agent process behavior.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QaSuiteInfraError } from "./errors.js";
import { extractGatewayMessageText } from "./gateway-log-sentinel.js";
import { runQaCli } from "./qa-cli-process.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import { readSessionTranscriptSummary } from "./suite-runtime-agent-session.js";
import { waitForGatewayHealthy, waitForTransportReady } from "./suite-runtime-gateway.js";
import type { QaDreamingStatus, QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { resolveQaGatewayTimeoutWithGraceMs } from "./timer-timeouts.js";

type QaMemorySearchResult = {
  results?: Array<{ snippet?: string; text?: string; path?: string }>;
};

type QaCronJob = {
  delivery?: { mode?: string };
  description?: string;
  id?: string;
  name?: string;
  payload?: { kind?: string; message?: string; text?: string; lightContext?: boolean };
  sessionTarget?: string;
  state?: { nextRunAtMs?: number };
};

type QaChatHistoryResponse = {
  messages?: unknown[];
};

type QaAgentTerminalReply =
  | { disposition: "visible"; text: string }
  | { disposition: "silent" }
  | { disposition: "empty" };

type QaAgentWaitResult = {
  status?: string;
  error?: string;
  stopReason?: string;
  terminalDelivery?: {
    status: "sent" | "suppressed" | "partial_failed" | "failed";
    resultCount: number;
  };
  terminalReceipt?: Record<string, unknown>;
  terminalReply?: QaAgentTerminalReply;
};

const MANAGED_DREAMING_CRON_MARKER = "[managed-by=memory-core.short-term-promotion]";
const MANAGED_DREAMING_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DREAMING_PROMPT = "__openclaw_memory_core_short_term_promotion_dream__";
const QA_HISTORY_RETRY_DEFAULT_MS = 250;
const QA_HISTORY_RETRY_MIN_MS = 100;
const QA_HISTORY_RETRY_MAX_MS = 5_000;
const QA_TRANSCRIPT_EVIDENCE_TIMEOUT_MS = 5_000;
const QA_TRANSCRIPT_EVIDENCE_POLL_MS = 50;

async function startAgentRun(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
  params: {
    sessionKey: string;
    message: string;
    to?: string;
    threadId?: string;
    provider?: string;
    model?: string;
    taskTracking?: boolean;
    timeoutMs?: number;
    attachments?: Array<{
      mimeType: string;
      fileName: string;
      content: string;
    }>;
  },
) {
  if (params.taskTracking === false) {
    const target = params.to ?? "dm:qa-operator";
    const delivery = env.transport.buildAgentDelivery({ target });
    const started = (await env.gateway.call(
      "chat.send",
      {
        idempotencyKey: randomUUID(),
        sessionKey: params.sessionKey,
        message: params.message,
        deliver: true,
        originatingChannel: delivery.replyChannel,
        originatingTo: delivery.replyTo,
      },
      {
        timeoutMs: params.timeoutMs ?? 30_000,
      },
    )) as { runId?: string; status?: string };
    if (!started.runId) {
      throw new Error(`chat.send did not return a runId: ${JSON.stringify(started)}`);
    }
    return started;
  }
  const target = params.to ?? "dm:qa-operator";
  const delivery = env.transport.buildAgentDelivery({ target });
  const started = (await env.gateway.call(
    "agent",
    {
      idempotencyKey: randomUUID(),
      agentId: "qa",
      sessionKey: params.sessionKey,
      message: params.message,
      deliver: true,
      channel: delivery.channel,
      to: delivery.to ?? target,
      replyChannel: delivery.replyChannel,
      replyTo: delivery.replyTo,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.attachments ? { attachments: params.attachments } : {}),
    },
    {
      timeoutMs: params.timeoutMs ?? 30_000,
    },
  )) as { runId?: string; status?: string };
  if (!started.runId) {
    throw new Error(`agent call did not return a runId: ${JSON.stringify(started)}`);
  }
  return started;
}

async function waitForAgentRun(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  runId: string,
  timeoutMs = 30_000,
) {
  const waitTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 30_000);
  try {
    return (await env.gateway.call(
      "agent.wait",
      {
        runId,
        timeoutMs: waitTimeoutMs,
      },
      {
        timeoutMs: resolveQaGatewayTimeoutWithGraceMs(waitTimeoutMs),
      },
    )) as QaAgentWaitResult;
  } catch (error) {
    throw new QaSuiteInfraError(
      "agent_wait_failed",
      `agent.wait failed: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function isSuccessfulAgentWaitResult(waited: QaAgentWaitResult) {
  if (waited.status === "ok" || waited.status === "completed" || waited.status === "succeeded") {
    return true;
  }
  return waited.status === "error" && waited.error?.trim().toLowerCase() === "completed";
}

function readLatestAssistantTextFromHistory(history: QaChatHistoryResponse | undefined) {
  for (const message of (history?.messages ?? []).toReversed()) {
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    const text = extractGatewayMessageText(message);
    if (text) {
      return text;
    }
  }
  return undefined;
}

async function readLatestAgentHistoryReply(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  sessionKey: string,
) {
  const history = (await env.gateway.call(
    "chat.history",
    {
      sessionKey,
      limit: 12,
    },
    {
      timeoutMs: 10_000,
    },
  )) as QaChatHistoryResponse | undefined;
  return readLatestAssistantTextFromHistory(history);
}

function resolveRetryableHistoryDelayMs(error: unknown) {
  let current: unknown = error;
  // QA adds redacted logs in two wrapper layers. Walk their causes so retry
  // policy consumes the protocol contract instead of parsing decorated text.
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    const code = current.gatewayCode ?? current.code;
    if (code === "UNAVAILABLE" && current.retryable === true) {
      const detailMethod = isRecord(current.details) ? current.details.method : undefined;
      if (typeof detailMethod !== "string" || detailMethod === "chat.history") {
        const retryAfterMs = current.retryAfterMs;
        const rawDelayMs =
          typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
            ? retryAfterMs
            : QA_HISTORY_RETRY_DEFAULT_MS;
        return Math.min(
          Math.max(Math.floor(rawDelayMs), QA_HISTORY_RETRY_MIN_MS),
          QA_HISTORY_RETRY_MAX_MS,
        );
      }
    }
    current = current.cause;
  }
  return null;
}

async function waitForAgentHistoryReply(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  sessionKey: string,
  predicate: (text: string) => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 250,
) {
  const startedAt = Date.now();
  let lastRetryableHistoryError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    let delayMs = intervalMs;
    let text: string | undefined;
    try {
      text = await readLatestAgentHistoryReply(env, sessionKey);
      lastRetryableHistoryError = undefined;
    } catch (error) {
      const retryDelayMs = resolveRetryableHistoryDelayMs(error);
      if (retryDelayMs === null) {
        throw error;
      }
      lastRetryableHistoryError = error;
      delayMs = retryDelayMs;
    }
    if (text && (await predicate(text))) {
      return { text };
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(delayMs, remainingMs));
  }
  const message = `timed out after ${timeoutMs}ms`;
  throw lastRetryableHistoryError === undefined
    ? new Error(message)
    : new Error(message, { cause: lastRetryableHistoryError });
}

async function listCronJobs(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const payload = (await env.gateway.call(
    "cron.list",
    {
      includeDisabled: true,
      limit: 200,
      sortBy: "name",
      sortDir: "asc",
    },
    { timeoutMs: 30_000 },
  )) as {
    jobs?: QaCronJob[];
  };
  return payload.jobs ?? [];
}

function isManagedDreamingCronJob(job: QaCronJob) {
  if (job.description?.includes(MANAGED_DREAMING_CRON_MARKER)) {
    return true;
  }
  if (job.name !== MANAGED_DREAMING_CRON_NAME) {
    return false;
  }
  if (job.payload?.kind === "systemEvent" && job.payload.text === MANAGED_DREAMING_PROMPT) {
    return true;
  }
  return (
    job.payload?.kind === "agentTurn" &&
    job.payload.message === MANAGED_DREAMING_PROMPT &&
    job.payload.lightContext === true &&
    job.sessionTarget === "isolated" &&
    job.delivery?.mode === "none"
  );
}

function findManagedDreamingCronJob(jobs: readonly QaCronJob[]) {
  return jobs.find(isManagedDreamingCronJob);
}

async function readDoctorMemoryStatus(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  return (await env.gateway.call("doctor.memory.status", {}, { timeoutMs: 30_000 })) as {
    dreaming?: QaDreamingStatus;
  };
}

async function waitForMemorySearchMatch(params: {
  search: () => Promise<QaMemorySearchResult>;
  expectedNeedle: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const result = await params.search();
    const haystack = JSON.stringify(result.results ?? []);
    if (haystack.includes(params.expectedNeedle)) {
      return result;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`memory index missing expected fact after reindex: ${params.expectedNeedle}`);
}

async function forceMemoryIndex(params: {
  env: Pick<
    QaSuiteRuntimeEnv,
    "gateway" | "transport" | "primaryModel" | "alternateModel" | "providerMode" | "repoRoot"
  >;
  query: string;
  expectedNeedle: string;
}) {
  await waitForGatewayHealthy(params.env, 60_000);
  await waitForTransportReady(params.env, 60_000);
  await runQaCli(params.env, ["memory", "index", "--agent", "qa", "--force"], {
    timeoutMs: liveTurnTimeoutMs(params.env, 60_000),
  });
  const result = await waitForMemorySearchMatch({
    expectedNeedle: params.expectedNeedle,
    timeoutMs: liveTurnTimeoutMs(params.env, 20_000),
    search: async () =>
      (await runQaCli(
        params.env,
        ["memory", "search", "--agent", "qa", "--json", "--query", params.query],
        {
          timeoutMs: liveTurnTimeoutMs(params.env, 60_000),
          json: true,
        },
      )) as QaMemorySearchResult,
  });
  await params.env.gateway.restartAfterStateMutation?.(async () => {});
  return result;
}

async function waitForPersistedTranscriptToolEvidence(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  params: {
    sessionKey: string;
    toolName: string;
    requireSuccessfulResult: boolean;
  },
) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < QA_TRANSCRIPT_EVIDENCE_TIMEOUT_MS) {
    try {
      const summary = await readSessionTranscriptSummary(env, params.sessionKey, {
        allowEmpty: true,
      });
      const completedCount = summary.completedToolCallCounts[params.toolName] ?? 0;
      const successfulCount = summary.successfulToolCallCounts[params.toolName] ?? 0;
      if (completedCount > 0 && (!params.requireSuccessfulResult || successfulCount > 0)) {
        return;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    const remainingMs = QA_TRANSCRIPT_EVIDENCE_TIMEOUT_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(QA_TRANSCRIPT_EVIDENCE_POLL_MS, remainingMs));
  }
  throw new Error(
    `timed out after ${QA_TRANSCRIPT_EVIDENCE_TIMEOUT_MS}ms waiting for persisted ${params.toolName} transcript evidence`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}

async function runAgentPrompt(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
  params: {
    sessionKey: string;
    message: string;
    to?: string;
    threadId?: string;
    provider?: string;
    model?: string;
    taskTracking?: boolean;
    timeoutMs?: number;
    transcriptToolName?: string;
    requireSuccessfulTranscriptToolResult?: boolean;
    attachments?: Array<{
      mimeType: string;
      fileName: string;
      content: string;
    }>;
  },
) {
  const started = await startAgentRun(env, params);
  const waited = await waitForAgentRun(env, started.runId!, params.timeoutMs ?? 30_000);
  if (!isSuccessfulAgentWaitResult(waited)) {
    throw new Error(
      `agent.wait returned ${waited.status ?? "unknown"}: ${waited.error ?? "no error"}`,
    );
  }
  if (params.transcriptToolName) {
    await waitForPersistedTranscriptToolEvidence(env, {
      sessionKey: params.sessionKey,
      toolName: params.transcriptToolName,
      requireSuccessfulResult: params.requireSuccessfulTranscriptToolResult === true,
    });
  }
  return {
    started,
    waited,
  };
}

export {
  forceMemoryIndex,
  findManagedDreamingCronJob,
  listCronJobs,
  readDoctorMemoryStatus,
  runAgentPrompt,
  startAgentRun,
  waitForAgentHistoryReply,
  waitForAgentRun,
};

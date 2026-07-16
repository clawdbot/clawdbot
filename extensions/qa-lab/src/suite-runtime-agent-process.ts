// Qa Lab plugin module implements suite runtime agent process behavior.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  formatQaChildOutputTail,
  QA_CHILD_STDOUT_MAX_BYTES,
  readQaChildOutput,
} from "./child-output.js";
import { QaSuiteInfraError } from "./errors.js";
import { extractGatewayMessageText } from "./gateway-log-sentinel.js";
import { resolveQaNodeExecPath } from "./node-exec.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import { waitForGatewayHealthy, waitForTransportReady } from "./suite-runtime-gateway.js";
import type { QaDreamingStatus, QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { resolveQaGatewayTimeoutWithGraceMs } from "./timer-timeouts.js";
import { resolveQaWindowsSystem32ExePath } from "./windows-system-tools.js";

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

type QaAgentWaitResult = {
  status?: string;
  error?: string;
  stopReason?: string;
};

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, "g");
const MANAGED_DREAMING_CRON_MARKER = "[managed-by=memory-core.short-term-promotion]";
const MANAGED_DREAMING_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DREAMING_PROMPT = "__openclaw_memory_core_short_term_promotion_dream__";

function stripAnsiCodes(text: string) {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function findBalancedJsonEnd(text: string, startIndex: number) {
  const opening = text[startIndex];
  const firstClosing = opening === "{" ? "}" : opening === "[" ? "]" : "";
  if (!firstClosing) {
    return -1;
  }

  const stack = [firstClosing];
  let inString = false;
  let escaping = false;
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (stack.at(-1) !== char) {
        return -1;
      }
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }
  return -1;
}

function parseBalancedJsonPayloadStart(text: string) {
  const trimmedStart = text.search(/\S/u);
  if (trimmedStart < 0) {
    return undefined;
  }
  const char = text[trimmedStart];
  if (char !== "{" && char !== "[") {
    return undefined;
  }
  const end = findBalancedJsonEnd(text, trimmedStart);
  if (end <= trimmedStart) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(trimmedStart, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStructuredDiagnosticJson(value: unknown) {
  if (!isJsonRecord(value)) {
    return false;
  }
  const level = value.level ?? value.logLevel ?? value.severity;
  if (typeof level !== "string") {
    return false;
  }
  return (
    typeof value.message === "string" ||
    typeof value.msg === "string" ||
    typeof value.time === "string" ||
    typeof value.timestamp === "string"
  );
}

function isMemorySearchJsonPayload(value: unknown) {
  return isJsonRecord(value) && Array.isArray(value.results);
}

function isMemoryStatusJsonPayload(value: unknown) {
  if (Array.isArray(value)) {
    return true;
  }
  return isJsonRecord(value) && value.command === "memory" && value.subcommand === "status";
}

function resolveQaCliJsonPayloadMatcher(args: readonly string[]) {
  if (!args.includes("--json")) {
    return undefined;
  }
  if (args[0] === "memory" && args[1] === "search") {
    return isMemorySearchJsonPayload;
  }
  if (args[0] === "memory" && args[1] === "status") {
    return isMemoryStatusJsonPayload;
  }
  return undefined;
}

function parseQaCliJsonOutput(text: string, args: readonly string[]) {
  const cleaned = stripAnsiCodes(text).trim();
  if (!cleaned) {
    return {};
  }
  const matchesExpectedPayload = resolveQaCliJsonPayloadMatcher(args);
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    // Some startup repair logs are emitted on stdout before command JSON.
    const lines = cleaned.split(/\r?\n/);
    const candidates: unknown[] = [];
    for (const [index, line] of lines.entries()) {
      const candidate = line.trimStart();
      if (candidate !== line || (!candidate.startsWith("{") && !candidate.startsWith("["))) {
        continue;
      }
      const jsonTail = lines.slice(index).join("\n");
      try {
        candidates.push(JSON.parse(jsonTail) as unknown);
      } catch {
        const balanced = parseBalancedJsonPayloadStart(jsonTail);
        if (balanced !== undefined) {
          candidates.push(balanced);
        }
      }
    }
    const expectedPayload = candidates.find((value) => matchesExpectedPayload?.(value) === true);
    if (expectedPayload !== undefined) {
      return expectedPayload;
    }
    const payload = candidates.toReversed().find((value) => !isStructuredDiagnosticJson(value));
    if (payload !== undefined) {
      return payload;
    }
    const diagnosticOnly = candidates.at(-1);
    if (diagnosticOnly !== undefined) {
      return diagnosticOnly;
    }

    // Keep a line-oriented fallback for compact payloads followed by diagnostics.
    for (const line of lines.toReversed()) {
      const candidate = line.trim();
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
        continue;
      }
      try {
        return JSON.parse(candidate) as unknown;
      } catch {
        // Keep looking for the actual payload line.
      }
    }
    throw new Error(`qa cli returned non-JSON stdout: ${truncateUtf16Safe(cleaned, 240)}`);
  }
}

function signalQaCliProcessTree(
  child: Pick<ChildProcessWithoutNullStreams, "kill" | "pid">,
  signal: NodeJS.Signals,
) {
  if (process.platform === "win32") {
    if (typeof child.pid === "number") {
      const result = spawnSync(
        resolveQaWindowsSystem32ExePath("taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      if (!result.error && result.status === 0) {
        return;
      }
    }
    child.kill(signal);
    return;
  }
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The detached process group may already be gone; fall back to the child handle.
    }
  }
  child.kill(signal);
}

async function runQaCli(
  env: Pick<
    QaSuiteRuntimeEnv,
    "gateway" | "repoRoot" | "primaryModel" | "alternateModel" | "providerMode"
  >,
  args: string[],
  opts?: { timeoutMs?: number; json?: boolean; env?: NodeJS.ProcessEnv },
) {
  const stdout = createQaChildOutputCapture();
  const stderr = createQaChildOutputTail();
  const distEntryPath = path.join(env.repoRoot, "dist", "index.js");
  const nodeExecPath = await resolveQaNodeExecPath();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(nodeExecPath, [distEntryPath, ...args], {
      cwd: env.gateway.tempRoot,
      env: {
        ...env.gateway.runtimeEnv,
        ...opts?.env,
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutMs = resolveTimerTimeoutMs(opts?.timeoutMs, 60_000);
    const timeout = setTimeout(() => {
      signalQaCliProcessTree(child, "SIGKILL");
      reject(
        new QaSuiteInfraError("qa_cli_timeout", `qa cli timed out: openclaw ${args.join(" ")}`),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => appendQaChildOutput(stdout, chunk));
    child.stderr.on("data", (chunk) => appendQaChildOutputTail(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        if (stdout.exceeded) {
          reject(
            new Error(
              `qa cli stdout exceeded ${QA_CHILD_STDOUT_MAX_BYTES} bytes; refusing to parse truncated output`,
            ),
          );
          return;
        }
        resolve();
        return;
      }
      const stderrText = formatQaChildOutputTail(stderr, "qa cli stderr");
      reject(new Error(`qa cli failed (${code ?? "unknown"}): ${stderrText}`));
    });
  });
  const text = readQaChildOutput(stdout).trim();
  if (!opts?.json) {
    return text;
  }
  return parseQaCliJsonOutput(text, args);
}

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

async function waitForAgentHistoryReply(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  sessionKey: string,
  predicate: (text: string) => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 250,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const text = await readLatestAgentHistoryReply(env, sessionKey);
    if (text && (await predicate(text))) {
      return { text };
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(intervalMs, remainingMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
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

async function runAgentPrompt(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
  params: {
    sessionKey: string;
    message: string;
    to?: string;
    threadId?: string;
    provider?: string;
    model?: string;
    timeoutMs?: number;
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
  runQaCli,
  startAgentRun,
  waitForAgentHistoryReply,
  waitForAgentRun,
};

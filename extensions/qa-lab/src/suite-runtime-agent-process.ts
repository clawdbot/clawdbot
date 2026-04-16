import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveQaNodeExecPath } from "./node-exec.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import { waitForGatewayHealthy, waitForTransportReady } from "./suite-runtime-gateway.js";
import type { QaDreamingStatus, QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type QaMemorySearchResult = {
  results?: Array<{ snippet?: string; text?: string; path?: string }>;
};

async function runQaCli(
  env: Pick<
    QaSuiteRuntimeEnv,
    "gateway" | "repoRoot" | "primaryModel" | "alternateModel" | "providerMode"
  >,
  args: string[],
  opts?: { timeoutMs?: number; json?: boolean },
) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const distEntryPath = path.join(env.repoRoot, "dist", "index.js");
  const nodeExecPath = await resolveQaNodeExecPath();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(nodeExecPath, [distEntryPath, ...args], {
      cwd: env.gateway.tempRoot,
      env: env.gateway.runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`qa cli timed out: openclaw ${args.join(" ")}`));
    }, opts?.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `qa cli failed (${code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
  });
  const text = Buffer.concat(stdout).toString("utf8").trim();
  if (!opts?.json) {
    return text;
  }
  return text ? (JSON.parse(text) as unknown) : {};
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
    timeoutMs?: number;
    attachments?: Array<{
      mimeType: string;
      fileName: string;
      content: string;
    }>;
  },
) {
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
      to: target,
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
  return (await env.gateway.call(
    "agent.wait",
    {
      runId,
      timeoutMs,
    },
    {
      timeoutMs: timeoutMs + 5_000,
    },
  )) as { status?: string; error?: string };
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
    jobs?: Array<{
      id?: string;
      name?: string;
      payload?: { kind?: string; text?: string };
      state?: { nextRunAtMs?: number };
    }>;
  };
  return payload.jobs ?? [];
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
    await new Promise((resolve) => setTimeout(resolve, 500));
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
  return await waitForMemorySearchMatch({
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
  if (waited.status !== "ok") {
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
  listCronJobs,
  readDoctorMemoryStatus,
  runAgentPrompt,
  runQaCli,
  startAgentRun,
  waitForMemorySearchMatch,
  waitForAgentRun,
};

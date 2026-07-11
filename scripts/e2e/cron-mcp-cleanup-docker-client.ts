// Cron Mcp Cleanup Docker Client script supports OpenClaw repository automation.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { GatewayRpcClient } from "../../test/e2e/qa-lab/runtime/mcp-channels.fixture.ts";
import { readPositiveIntEnv } from "./lib/env-limits.mjs";

const execFileAsync = promisify(execFile);
const PROBE_PID_WAIT_MS = readCronMcpCleanupProbePidWaitMs();
type McpChannelsHarness = typeof import("../../test/e2e/qa-lab/runtime/mcp-channels.fixture.ts");
let mcpChannelsHarness: McpChannelsHarness | undefined;

type CronJob = { id?: string };
type CronRunResult = { ok?: boolean; enqueued?: boolean; runId?: string };
type AgentRunResult = { runId?: string; status?: string };
type CronFinishedPayload = { status?: unknown };

async function loadMcpChannelsHarness(): Promise<McpChannelsHarness> {
  mcpChannelsHarness ??= await import("../../test/e2e/qa-lab/runtime/mcp-channels.fixture.ts");
  return mcpChannelsHarness;
}

export function readCronMcpCleanupProbePidWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv("OPENCLAW_CRON_MCP_CLEANUP_PID_WAIT_MS", 120_000, env);
}

export function assertCronFinishedOk(finished: CronFinishedPayload | undefined): void {
  if (finished?.status !== "ok") {
    throw new Error(`cron cleanup run did not finish ok: ${JSON.stringify(finished)}`);
  }
}

function parseProbePid(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^[1-9]\d*$/u.test(text)) {
    return undefined;
  }
  const pid = Number(text);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

async function readProbePid(pidPath: string): Promise<number | undefined> {
  try {
    return parseProbePid(await fs.readFile(pidPath, "utf-8"));
  } catch {
    return undefined;
  }
}

async function readProbePids(pidsPath: string): Promise<number[]> {
  try {
    const raw = await fs.readFile(pidsPath, "utf-8");
    const pids: number[] = [];
    const seen = new Set<number>();
    for (const line of raw.split(/\r?\n/)) {
      const pid = parseProbePid(line);
      if (pid === undefined || seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

async function describeProbePid(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "args="]);
    const args = stdout.trim();
    return args.length > 0 ? args : undefined;
  } catch {
    return undefined;
  }
}

export async function waitForProbePid(
  pidPath: string,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<number | undefined> {
  const timeoutMs = options.timeoutMs ?? PROBE_PID_WAIT_MS;
  const pollMs = options.pollMs ?? 100;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pid = await readProbePid(pidPath);
    if (pid) {
      return pid;
    }
    await delay(pollMs);
  }
  return undefined;
}

async function waitForProbeExit(params: {
  pid: number;
  label: string;
  timeoutMs?: number;
}): Promise<void> {
  const { pid, label, timeoutMs = 30_000 } = params;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const args = await describeProbePid(pid);
    if (!args || !args.includes("openclaw-cron-mcp-cleanup-probe")) {
      return;
    }
    await delay(100);
  }
  const args = await describeProbePid(pid);
  throw new Error(`${label} MCP probe process still alive after run: pid=${pid} args=${args}`);
}

async function waitForAllProbeExits(params: {
  pidsPath: string;
  label: string;
  timeoutMs: number;
}): Promise<number[]> {
  const startedAt = Date.now();
  let observed: number[] = [];
  while (Date.now() - startedAt < params.timeoutMs) {
    observed = await readProbePids(params.pidsPath);
    if (observed.length > 0) {
      let allExited = true;
      for (const pid of observed) {
        const args = await describeProbePid(pid);
        if (args?.includes("openclaw-cron-mcp-cleanup-probe")) {
          allExited = false;
          break;
        }
      }
      if (allExited) {
        return observed;
      }
    }
    await delay(100);
  }
  const descriptions = await Promise.all(
    observed.map(async (pid) => ({ pid, args: await describeProbePid(pid) })),
  );
  throw new Error(
    `${params.label} MCP probe processes still alive after run: ${JSON.stringify(descriptions)}`,
  );
}

async function resetProbeFiles(params: {
  pidPath: string;
  pidsPath: string;
  exitPath: string;
}): Promise<void> {
  await fs.rm(params.pidPath, { force: true });
  await fs.rm(params.pidsPath, { force: true });
  await fs.rm(params.exitPath, { force: true });
}

async function runCronCleanupScenario(params: {
  gateway: GatewayRpcClient;
  pidPath: string;
}): Promise<{ jobId: string; runId?: string; pid: number; status?: unknown }> {
  const harness = await loadMcpChannelsHarness();
  const assert: McpChannelsHarness["assert"] = harness.assert;
  const { waitFor } = harness;
  const { gateway, pidPath } = params;
  const job = await gateway.request<CronJob>("cron.add", {
    name: "cron mcp cleanup docker e2e",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: "Use available context and then stop.",
      timeoutSeconds: 90,
      lightContext: true,
      toolsAllow: ["bundle-mcp", "cronCleanupProbe__cleanup_probe"],
    },
    delivery: { mode: "none" },
  });
  assert(job.id, `cron.add did not return an id: ${JSON.stringify(job)}`);

  const run = await gateway.request<CronRunResult>("cron.run", {
    id: job.id,
    mode: "force",
  });
  assert(
    run.ok === true && run.enqueued === true,
    `cron.run was not enqueued: ${JSON.stringify(run)}`,
  );

  const started = await waitFor(
    "cron started event",
    () =>
      gateway.events.find(
        (entry) =>
          entry.event === "cron" &&
          entry.payload.jobId === job.id &&
          entry.payload.action === "started",
      )?.payload,
    60_000,
  );
  assert(started, "missing cron started event");

  const pid = await waitForProbePid(pidPath);
  assert(
    pid,
    `cron MCP probe did not start within ${PROBE_PID_WAIT_MS}ms; missing pid file at ${pidPath}; events=${JSON.stringify(
      gateway.events.slice(-10),
    )}`,
  );
  const initialArgs = await describeProbePid(pid);
  assert(
    initialArgs === undefined || initialArgs.includes("openclaw-cron-mcp-cleanup-probe"),
    `cron MCP probe pid did not look like the test server: pid=${pid} args=${initialArgs}`,
  );

  const finished = await waitFor(
    "cron finished event",
    () =>
      gateway.events.find(
        (entry) =>
          entry.event === "cron" &&
          entry.payload.jobId === job.id &&
          entry.payload.action === "finished",
      )?.payload,
    240_000,
  );
  assert(finished, "missing cron finished event");
  assertCronFinishedOk(finished);

  await waitForProbeExit({ pid, label: "cron" });
  return {
    jobId: job.id,
    runId: run.runId,
    pid,
    status: finished.status,
  };
}

async function runSubagentCleanupScenario(params: {
  gateway: GatewayRpcClient;
  pidPath: string;
  pidsPath: string;
  exitPath: string;
}): Promise<{ runId: string; exitedPids: number[]; pids: number[] }> {
  const harness = await loadMcpChannelsHarness();
  const assert: McpChannelsHarness["assert"] = harness.assert;
  const { gateway, pidPath, pidsPath, exitPath } = params;
  await resetProbeFiles({ pidPath, pidsPath, exitPath });

  const run = await gateway.request<AgentRunResult>(
    "agent",
    {
      message: "Use available context and then stop.",
      sessionKey: `agent:main:subagent:docker-${randomUUID()}`,
      agentId: "main",
      lane: "subagent",
      cleanupBundleMcpOnRunEnd: true,
      idempotencyKey: randomUUID(),
      deliver: false,
      timeout: 90,
      bestEffortDeliver: true,
    },
    { timeoutMs: 240_000 },
  );
  assert(
    run.status === "accepted" && run.runId,
    `agent did not accept subagent cleanup run: ${JSON.stringify(run)}`,
  );

  const finished = await gateway.request<{ status?: string }>(
    "agent.wait",
    {
      runId: run.runId,
      timeoutMs: 240_000,
    },
    { timeoutMs: 250_000 },
  );
  assert(
    finished.status === "ok",
    `subagent cleanup run did not finish ok: ${JSON.stringify(finished)}`,
  );

  const exitedPids = await waitForAllProbeExits({
    pidsPath,
    label: "subagent",
    timeoutMs: 240_000,
  });
  return {
    runId: run.runId,
    exitedPids,
    pids: await readProbePids(pidsPath),
  };
}

async function main() {
  const harness = await loadMcpChannelsHarness();
  const assert: McpChannelsHarness["assert"] = harness.assert;
  const { connectGateway } = harness;
  const gatewayUrl = process.env.GW_URL?.trim();
  const gatewayToken = process.env.GW_TOKEN?.trim();
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const pidPath = path.join(stateDir, "cron-mcp-cleanup", "probe.pid");
  const pidsPath = path.join(stateDir, "cron-mcp-cleanup", "probe.pids");
  const exitPath = path.join(stateDir, "cron-mcp-cleanup", "probe.exit");
  assert(gatewayUrl, "missing GW_URL");
  assert(gatewayToken, "missing GW_TOKEN");

  const gateway = await connectGateway({ url: gatewayUrl, token: gatewayToken });
  try {
    const cron = await runCronCleanupScenario({ gateway, pidPath });
    const subagent = await runSubagentCleanupScenario({ gateway, pidPath, pidsPath, exitPath });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        cron,
        subagent,
      }) + "\n",
    );
  } finally {
    await gateway.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { assert, connectGateway, type GatewayRpcClient, waitFor } from "./mcp-channels-harness.ts";

const execFileAsync = promisify(execFile);

type CronJob = { id?: string };
type CronRunResult = { ok?: boolean; enqueued?: boolean; runId?: string };
type AgentRunResult = { runId?: string; status?: string };

async function readProbePid(pidPath: string): Promise<number | undefined> {
  try {
    const raw = (await fs.readFile(pidPath, "utf-8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
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
      const pid = Number.parseInt(line.trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) {
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

async function waitForProbePid(pidPath: string): Promise<number | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 600_000) {
    const pid = await readProbePid(pidPath);
    if (pid) {
      return pid;
    }
    await delay(100);
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

async function waitForAnyProbeExit(params: {
  pidsPath: string;
  label: string;
  timeoutMs: number;
}): Promise<number> {
  const startedAt = Date.now();
  let observed: number[] = [];
  while (Date.now() - startedAt < params.timeoutMs) {
    observed = await readProbePids(params.pidsPath);
    for (const pid of observed) {
      const args = await describeProbePid(pid);
      if (!args || !args.includes("openclaw-cron-mcp-cleanup-probe")) {
        return pid;
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
    `cron MCP probe did not start; missing pid file at ${pidPath}; events=${JSON.stringify(
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
}): Promise<{ runId: string; exitedPid: number; pids: number[] }> {
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

  const exitedPid = await waitForAnyProbeExit({
    pidsPath,
    label: "subagent",
    timeoutMs: 240_000,
  });
  return {
    runId: run.runId,
    exitedPid,
    pids: await readProbePids(pidsPath),
  };
}

async function main() {
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

await main();

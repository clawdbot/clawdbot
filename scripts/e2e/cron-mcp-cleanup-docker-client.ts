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
type CronRunHistoryEntry = {
  runId?: unknown;
  status?: unknown;
  summary?: unknown;
  diagnostics?: {
    summary?: unknown;
    entries?: Array<{ source?: unknown; severity?: unknown; message?: unknown }>;
  };
};
type MockOpenAiRequest = { path?: unknown; body?: unknown };

const MCP_TOOL_PREFIX = "cronCleanupProbe__";
const MCP_SUPPRESSION_WARNING = "explicit toolsAllow omits every configured MCP selector";

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

async function readMockRequests(requestLogPath: string): Promise<MockOpenAiRequest[]> {
  const raw = await fs.readFile(requestLogPath, "utf-8");
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MockOpenAiRequest);
}

function functionCallOutputText(request: MockOpenAiRequest): string {
  let body = request.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      return "";
    }
  }
  const input =
    body && typeof body === "object" && Array.isArray((body as { input?: unknown }).input)
      ? (body as { input: unknown[] }).input
      : [];
  return input
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const record = item as { type?: unknown; output?: unknown };
      if (record.type !== "function_call_output") {
        return [];
      }
      return [
        typeof record.output === "string" ? record.output : JSON.stringify(record.output ?? ""),
      ];
    })
    .join("\n");
}

async function waitForModelRequest(params: {
  marker: string;
  requestLogPath: string;
  waitFor: McpChannelsHarness["waitFor"];
}): Promise<MockOpenAiRequest> {
  return await params.waitFor(
    `mock OpenAI request for ${params.marker}`,
    async () => {
      const requests = await readMockRequests(params.requestLogPath);
      return requests.find((request) => {
        const bodyText = JSON.stringify(request.body);
        return (
          request.path === "/v1/responses" &&
          typeof bodyText === "string" &&
          bodyText.includes(params.marker)
        );
      });
    },
    30_000,
  );
}

function hasMcpSuppressionWarning(entry: CronRunHistoryEntry): boolean {
  return (
    (typeof entry.diagnostics?.summary === "string" &&
      entry.diagnostics.summary.includes(MCP_SUPPRESSION_WARNING)) ||
    (entry.diagnostics?.entries ?? []).some(
      (diagnostic) =>
        diagnostic.source === "cron-preflight" &&
        diagnostic.severity === "warn" &&
        typeof diagnostic.message === "string" &&
        diagnostic.message.includes(MCP_SUPPRESSION_WARNING),
    )
  );
}

type CronAuthorityScenarioResult = {
  case: string;
  status: unknown;
  modelMcpTools: string[];
  warningPersisted: boolean;
  probeStarted: boolean;
  probeExited?: boolean;
};

async function runCronAuthorityScenario(params: {
  gateway: GatewayRpcClient;
  pidPath: string;
  pidsPath: string;
  exitPath: string;
  requestLogPath: string;
  caseName: string;
  marker: string;
  toolsAllow: string[];
  expectedMcpTools: string[];
  expectWarning: boolean;
  expectProbeStart: boolean;
  expectMcpNamespace: boolean;
  proofResultMarker?: string;
}): Promise<CronAuthorityScenarioResult> {
  const harness = await loadMcpChannelsHarness();
  const assert: McpChannelsHarness["assert"] = harness.assert;
  const { waitFor } = harness;
  const { gateway, pidPath, pidsPath, exitPath } = params;
  await resetProbeFiles({ pidPath, pidsPath, exitPath });
  const job = await gateway.request<CronJob>("cron.add", {
    name: `cron MCP authority ${params.caseName}`,
    enabled: true,
    schedule: { kind: "every", everyMs: 12 * 60 * 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: `Return ${params.marker} and then stop.`,
      timeoutSeconds: 90,
      lightContext: true,
      toolsAllow: params.toolsAllow,
    },
    delivery: { mode: "none" },
  });
  assert(job.id, `cron.add did not return an id: ${JSON.stringify(job)}`);

  try {
    const run = await gateway.request<CronRunResult>("cron.run", {
      id: job.id,
      mode: "force",
    });
    assert(
      run.ok === true && run.enqueued === true && run.runId,
      `cron.run was not enqueued: ${JSON.stringify(run)}`,
    );

    const started = await waitFor(
      `cron started event for ${params.caseName}`,
      () =>
        gateway.events.find(
          (entry) =>
            entry.event === "cron" &&
            entry.payload.jobId === job.id &&
            entry.payload.action === "started",
        )?.payload,
      60_000,
    );
    assert(started, `missing cron started event for ${params.caseName}`);

    const pid = params.expectProbeStart ? await waitForProbePid(pidPath) : undefined;
    if (params.expectProbeStart) {
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
    }

    const finished = await waitFor(
      `cron finished event for ${params.caseName}`,
      () =>
        gateway.events.find(
          (entry) =>
            entry.event === "cron" &&
            entry.payload.jobId === job.id &&
            entry.payload.action === "finished",
        )?.payload,
      240_000,
    );
    assert(finished, `missing cron finished event for ${params.caseName}`);
    assertCronFinishedOk(finished);

    const historyEntry = await waitFor(
      `persisted cron history for ${params.caseName}`,
      async () => {
        const history = await gateway.request<{ entries?: CronRunHistoryEntry[] }>("cron.runs", {
          id: job.id,
          runId: run.runId,
          limit: 1,
        });
        return history.entries?.find((entry) => entry.runId === run.runId);
      },
      30_000,
    );
    assert(
      historyEntry.status === "ok",
      `persisted cron run did not finish ok: ${JSON.stringify(historyEntry)}`,
    );
    assert(
      typeof historyEntry.summary === "string" && historyEntry.summary.includes(params.marker),
      `cron authority proof did not reach its validated final response for ${params.caseName}: ${JSON.stringify(historyEntry.summary)}`,
    );
    const warningPersisted = hasMcpSuppressionWarning(historyEntry);
    assert(
      warningPersisted === params.expectWarning,
      `unexpected MCP suppression warning state for ${params.caseName}: ${JSON.stringify(historyEntry.diagnostics)}`,
    );

    const modelRequest = await waitForModelRequest({
      marker: params.marker,
      requestLogPath: params.requestLogPath,
      waitFor,
    });
    const modelRequestText = JSON.stringify(modelRequest.body);
    const hasMcpNamespace = modelRequestText.includes("MCP namespace globals are available");
    assert(
      hasMcpNamespace === params.expectMcpNamespace,
      `unexpected MCP namespace visibility for ${params.caseName}: ${hasMcpNamespace}`,
    );
    let mcpTools: string[] = [];
    const proofResultMarker = params.proofResultMarker;
    if (proofResultMarker) {
      const proofOutput = await waitFor(
        `mock-model MCP result for ${params.caseName}`,
        async () => {
          const requests = await readMockRequests(params.requestLogPath);
          return requests
            .map((request) => functionCallOutputText(request))
            .find((output) => output.includes(proofResultMarker));
        },
        30_000,
      );
      if (/"hasCleanup"\s*:\s*true/u.test(proofOutput)) {
        mcpTools.push(`${MCP_TOOL_PREFIX}cleanup_probe`);
      }
      if (/"hasSecondary"\s*:\s*true/u.test(proofOutput)) {
        mcpTools.push(`${MCP_TOOL_PREFIX}secondary_probe`);
      }
    }
    mcpTools = mcpTools.toSorted();
    assert(
      JSON.stringify(mcpTools) === JSON.stringify(params.expectedMcpTools.toSorted()),
      `unexpected code-mode MCP tool surface for ${params.caseName}: ${JSON.stringify(mcpTools)}`,
    );

    const observedProbePids = await readProbePids(pidsPath);
    assert(
      observedProbePids.length > 0 === params.expectProbeStart,
      `unexpected MCP probe lifecycle for ${params.caseName}: ${JSON.stringify(observedProbePids)}`,
    );
    if (params.expectProbeStart) {
      await waitForAllProbeExits({
        pidsPath,
        label: params.caseName,
        timeoutMs: 30_000,
      });
    }

    return {
      case: params.caseName,
      status: historyEntry.status,
      modelMcpTools: mcpTools,
      warningPersisted,
      probeStarted: observedProbePids.length > 0,
      ...(params.expectProbeStart ? { probeExited: true } : {}),
    };
  } finally {
    await gateway.request("cron.remove", { id: job.id });
  }
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
  const requestLogPath = process.env.MOCK_REQUEST_LOG?.trim();
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const pidPath = path.join(stateDir, "cron-mcp-cleanup", "probe.pid");
  const pidsPath = path.join(stateDir, "cron-mcp-cleanup", "probe.pids");
  const exitPath = path.join(stateDir, "cron-mcp-cleanup", "probe.exit");
  assert(gatewayUrl, "missing GW_URL");
  assert(gatewayToken, "missing GW_TOKEN");
  assert(requestLogPath, "missing MOCK_REQUEST_LOG");

  const gateway = await connectGateway({
    url: gatewayUrl,
    token: gatewayToken,
    bindFreshDevice: true,
  });
  try {
    const authority = [
      await runCronAuthorityScenario({
        gateway,
        pidPath,
        pidsPath,
        exitPath,
        requestLogPath,
        caseName: "finite-core-only",
        marker: "OPENCLAW_E2E_CRON_MCP_FINITE_CORE_ONLY",
        toolsAllow: ["read"],
        expectedMcpTools: [],
        expectWarning: true,
        expectProbeStart: false,
        expectMcpNamespace: false,
      }),
      await runCronAuthorityScenario({
        gateway,
        pidPath,
        pidsPath,
        exitPath,
        requestLogPath,
        caseName: "exact-mcp-selector",
        marker: "OPENCLAW_E2E_CRON_MCP_EXACT_SELECTOR",
        toolsAllow: ["cronCleanupProbe__cleanup_probe"],
        expectedMcpTools: ["cronCleanupProbe__cleanup_probe"],
        expectWarning: false,
        expectProbeStart: true,
        expectMcpNamespace: true,
        proofResultMarker: "OPENCLAW_E2E_CRON_MCP_EXACT_RESULT",
      }),
      await runCronAuthorityScenario({
        gateway,
        pidPath,
        pidsPath,
        exitPath,
        requestLogPath,
        caseName: "non-codex-scoped-server",
        marker: "OPENCLAW_E2E_CRON_MCP_NON_CODEX_SCOPE",
        toolsAllow: ["bundle-mcp"],
        expectedMcpTools: ["cronCleanupProbe__cleanup_probe", "cronCleanupProbe__secondary_probe"],
        expectWarning: false,
        expectProbeStart: true,
        expectMcpNamespace: true,
        proofResultMarker: "OPENCLAW_E2E_CRON_MCP_NON_CODEX_RESULT",
      }),
    ];
    const subagent = await runSubagentCleanupScenario({ gateway, pidPath, pidsPath, exitPath });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        runtime: "openclaw",
        authority,
        cleanup: {
          subagentProbeCount: subagent.pids.length,
          subagentProbesExited: subagent.exitedPids.length === subagent.pids.length,
        },
      }) + "\n",
    );
  } finally {
    await gateway.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

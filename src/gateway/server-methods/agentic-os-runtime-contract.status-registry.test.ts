import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import type { waitForAgentJob } from "./agent-job.js";
import type { GatewayRequestHandlers } from "./types.js";

const spawnSubagentDirectMock = vi.hoisted(() =>
  vi.fn<typeof spawnSubagentDirect>(async (_request, context) => ({
    status: "accepted",
    childSessionKey: context.preallocatedChildSessionKey,
    runId: context.preallocatedRunId,
    mode: "run",
  })),
);
const waitForAgentJobMock = vi.hoisted(() => vi.fn<typeof waitForAgentJob>(async () => null));
const findTaskByRunIdForStatusMock = vi.hoisted(() =>
  vi.fn((): { status: string; startedAt?: number; endedAt?: number } | undefined => undefined),
);

vi.mock("../../agents/subagent-spawn.js", () => ({ spawnSubagentDirect: spawnSubagentDirectMock }));
vi.mock("./agent-job.js", () => ({ waitForAgentJob: waitForAgentJobMock }));
vi.mock("../../tasks/task-status-access.js", () => ({
  findTaskByRunIdForStatus: findTaskByRunIdForStatusMock,
}));

type RespondCall = [boolean, unknown?, { code?: string; message: string }?];

let handlers: GatewayRequestHandlers;
let registry: typeof import("../../agents/subagent-registry.test-helpers.js");
let runtimeStateDir: string | undefined;

const acquireParams = {
  client_lease_id: "lease-a",
  idempotency_key: "lease-idem-a",
  run_id: "run-a",
  phase: "phase-b",
  transition_id: "transition-a",
  agent_id: "ai-engineer",
  requester_agent_id: "main",
  ttl_ms: 60_000,
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function payload(call: RespondCall): Record<string, unknown> {
  expect(call[0], call[2]?.message).toBe(true);
  return call[1] as Record<string, unknown>;
}

async function invoke(method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`missing handler: ${method}`);
  }
  await handler({
    params,
    respond: respond as never,
    context: {
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main" }, { id: "ai-engineer" }] },
      }),
      loadGatewayModelCatalog: async () => [],
      loadGatewayModelCatalogSnapshot: async () => ({ entries: [] }),
      logGateway: { debug: () => {}, error: () => {}, warn: () => {} },
    } as never,
    client: null,
    req: { type: "req", id: "req-1", method },
    isWebchatConnect: () => false,
  });
  const call = respond.mock.calls[0] as RespondCall | undefined;
  if (!call) {
    throw new Error(`missing response for ${method}`);
  }
  return call;
}

async function trackedSession() {
  const lease = payload(await invoke("subagents.allowLease.acquire", acquireParams));
  const task = "verify registry fallback";
  return payload(
    await invoke("sessions_spawn", {
      task,
      taskName: "verify-registry-fallback",
      runtime: "subagent",
      mode: "run",
      agentId: "ai-engineer",
      gateway_lease_id: lease.gateway_lease_id,
      client_request_id: "spawn-a",
      idempotency_key: "spawn-idem-a",
      metadata: {
        run_id: acquireParams.run_id,
        transition_id: acquireParams.transition_id,
        client_request_id: "spawn-a",
        idempotency_key: "spawn-idem-a",
        phase: acquireParams.phase,
        agent_id: acquireParams.agent_id,
        task_digest: sha256Hex(task),
      },
    }),
  );
}

function registryRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  return {
    runId: "registry-run",
    childSessionKey: "agent:ai-engineer:subagent:registry",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "registry fallback",
    cleanup: "keep",
    createdAt: 1,
    ...overrides,
  };
}

function terminalRun(
  runId: string,
  childSessionKey: string,
  status: "ok" | "error" | "timeout",
  createdAt = 20,
): SubagentRunRecord {
  const outcome: NonNullable<SubagentRunRecord["outcome"]> = {
    status,
    ...(status === "error" ? { error: "registry failed" } : {}),
    startedAt: createdAt + 2,
    endedAt: createdAt + 5,
  };
  return registryRun({
    runId,
    childSessionKey,
    createdAt,
    startedAt: outcome.startedAt,
    endedAt: outcome.endedAt,
    outcome,
    execution: {
      status: "terminal",
      acceptedAt: createdAt,
      startedAt: outcome.startedAt,
      endedAt: outcome.endedAt,
      outcome,
    },
  });
}

describe("Agentic OS sessions_status registry fallback", () => {
  beforeEach(async () => {
    runtimeStateDir = mkdtempSync(path.join(tmpdir(), "openclaw-agentic-os-status-registry-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", runtimeStateDir);
    vi.resetModules();
    registry = await import("../../agents/subagent-registry.test-helpers.js");
    registry.resetSubagentRegistryForTests({ persist: false });
    ({ agenticOsRuntimeContractHandlers: handlers } =
      await import("./agentic-os-runtime-contract.js"));
    spawnSubagentDirectMock.mockClear();
    waitForAgentJobMock.mockReset();
    waitForAgentJobMock.mockResolvedValue(null);
    findTaskByRunIdForStatusMock.mockReset();
    findTaskByRunIdForStatusMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    registry?.resetSubagentRegistryForTests({ persist: false });
    if (runtimeStateDir) {
      rmSync(runtimeStateDir, { recursive: true, force: true });
      runtimeStateDir = undefined;
    }
  });

  it("falls back to an exact active registry row and ignores a newer mismatched row", async () => {
    const accepted = await trackedSession();
    const sessionKey = accepted.session_key as string;
    const runId = accepted.runId as string;
    registry.addSubagentRunForTests(terminalRun("newer-mismatched-run", sessionKey, "ok", 30));
    registry.addSubagentRunForTests(
      registryRun({
        runId,
        childSessionKey: sessionKey,
        createdAt: 10,
        startedAt: 12,
        execution: { status: "running", acceptedAt: 10, startedAt: 12 },
      }),
    );

    expect(
      payload(await invoke("sessions_status", { session_key: sessionKey })).runtime_session,
    ).toMatchObject({
      key: sessionKey,
      lifecycle_status: "running",
      runtime_status: "running",
      terminal: false,
      started_at_ms: 12,
    });
  });

  it.each([
    ["ok", "completed", "completed"],
    ["error", "failed", "failed"],
    ["timeout", "failed", "timed_out"],
  ] as const)(
    "normalizes exact terminal registry %s outcomes",
    async (registryStatus, lifecycleStatus, runtimeStatus) => {
      const accepted = await trackedSession();
      const sessionKey = accepted.session_key as string;
      const runId = accepted.runId as string;
      registry.addSubagentRunForTests(terminalRun(runId, sessionKey, registryStatus));

      expect(
        payload(await invoke("sessions_status", { session_key: sessionKey })).runtime_session,
      ).toMatchObject({
        key: sessionKey,
        lifecycle_status: lifecycleStatus,
        runtime_status: runtimeStatus,
        terminal: true,
        started_at_ms: 22,
        ended_at_ms: 25,
      });
    },
  );

  it("does not use a mismatched registry row when task and job cache are absent", async () => {
    const accepted = await trackedSession();
    const sessionKey = accepted.session_key as string;
    registry.addSubagentRunForTests(terminalRun("mismatched-run", sessionKey, "ok", 30));

    expect(
      payload(await invoke("sessions_status", { session_key: sessionKey })).runtime_session,
    ).toMatchObject({
      key: sessionKey,
      lifecycle_status: "unknown",
      runtime_status: "unavailable",
      terminal: false,
    });
  });
});

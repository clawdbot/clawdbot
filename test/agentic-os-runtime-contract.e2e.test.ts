import { spawn as spawnProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const MODEL_REF = "agentic-os-probe/agentic-os-probe";
const CHILD_RESULT = "agentic os real child completed";
const FAILURE_MARKER = "agentic-os-real-child-failure";

type MockModelServer = {
  baseUrl: string;
  requests: string[];
  close: () => Promise<void>;
};

type AgenticAdapterProof = {
  agentic_adapter_live_catalog: true;
  agentic_adapter_release_succeeded: true;
  agentic_adapter_duplicate_release_parity: true;
  agentic_adapter_release_metadata_parity: true;
  agentic_adapter_post_release_absent: true;
};

const instances: OpenClawTestInstance[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("Agentic OS authenticated real Gateway runtime contract", () => {
  it(
    "leases, deduplicates, runs, observes, and releases a real child",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startMockModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "agentic-os-runtime-contract",
        config: createTestConfig(modelServer.baseUrl),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined },
      });
      instances.push(instance);
      await instance.startGateway();

      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      const writeOnlyClient = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.write", "operator.read"],
        deviceFamily: "writeonly",
      });
      const readOnlyClient = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.read"],
        deviceFamily: "readonly",
      });
      const secondPrincipalClient = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        deviceFamily: "secondary",
      });
      try {
        const catalog = await client.request<{
          runtimeMethods?: Array<{ name?: string; parameters?: string[] }>;
        }>("tools.catalog", { includePlugins: false });
        const runtimeMethods = catalog.runtimeMethods ?? [];
        const runtimeNames = runtimeMethods.map((entry) => entry.name);
        expect(runtimeNames).toEqual(
          expect.arrayContaining([
            "subagents.allowLease.acquire",
            "subagents.allowLease.status",
            "subagents.allowLease.release",
            "sessions_spawn",
            "sessions_list",
            "sessions_status",
            "sessions_history",
          ]),
        );

        const probeId = randomUUID();
        const agenticAdapterProof = await runAgenticAdapterReleaseProbe({
          client,
          runtimeMethods,
          probeId,
        });
        const acquireParams = {
          client_lease_id: `lease-${probeId}`,
          idempotency_key: `acquire-${probeId}`,
          run_id: `run-${probeId}`,
          phase: "phase-c",
          transition_id: `transition-${probeId}`,
          agent_id: "worker",
          requester_agent_id: "main",
          ttl_ms: 60_000,
        };
        await expect(
          readOnlyClient.request("subagents.allowLease.acquire", acquireParams),
        ).rejects.toThrow();
        await expect(
          writeOnlyClient.request("subagents.allowLease.acquire", acquireParams),
        ).rejects.toThrow();

        const firstLease = await client.request<{ gateway_lease_id: string }>(
          "subagents.allowLease.acquire",
          acquireParams,
        );
        const duplicateLease = await client.request<{ gateway_lease_id: string }>(
          "subagents.allowLease.acquire",
          acquireParams,
        );
        expect(duplicateLease.gateway_lease_id).toBe(firstLease.gateway_lease_id);
        const leaseStatus = await client.request<{ leases?: unknown[] }>(
          "subagents.allowLease.status",
          {},
        );
        expect(leaseStatus.leases).toHaveLength(1);
        expect(
          (
            await secondPrincipalClient.request<{ leases?: unknown[] }>(
              "subagents.allowLease.status",
              {},
            )
          ).leases,
        ).toEqual([]);

        const taskMarker = `real-child-marker-${probeId}`;
        const task = `Return the completion marker for ${taskMarker}`;
        const metadata = {
          run_id: acquireParams.run_id,
          transition_id: acquireParams.transition_id,
          client_request_id: `spawn-${probeId}`,
          idempotency_key: `spawn-idem-${probeId}`,
          phase: acquireParams.phase,
          agent_id: "worker",
          task_digest: sha256(task),
        };
        const spawnParams = {
          task,
          taskName: "agentic-os-real-gateway-probe",
          runtime: "subagent",
          mode: "run",
          agentId: "worker",
          gateway_lease_id: firstLease.gateway_lease_id,
          client_request_id: metadata.client_request_id,
          idempotency_key: metadata.idempotency_key,
          metadata,
        };
        await expect(
          client.request("sessions_spawn", {
            ...spawnParams,
            gateway_lease_id: "gateway-lease:missing",
          }),
        ).rejects.toThrow();
        await expect(secondPrincipalClient.request("sessions_spawn", spawnParams)).rejects.toThrow(
          /different authenticated principal/i,
        );

        let firstSpawn: { runId: string; session_key: string };
        let duplicateSpawn: { runId: string; session_key: string };
        try {
          [firstSpawn, duplicateSpawn] = await Promise.all([
            client.request<{ runId: string; session_key: string }>("sessions_spawn", spawnParams),
            client.request<{ runId: string; session_key: string }>("sessions_spawn", spawnParams),
          ]);
        } catch (error) {
          throw new Error(`real sessions_spawn failed: ${String(error)}\n${instance.logs()}`, {
            cause: error,
          });
        }
        expect(duplicateSpawn.session_key).toBe(firstSpawn.session_key);
        expect(duplicateSpawn.runId).toBe(firstSpawn.runId);
        const runningStatus = await client.request<{
          runtime_session?: {
            lifecycle_status?: string;
            runtime_status?: string;
            terminal?: boolean;
          };
        }>("sessions_status", { session_key: firstSpawn.session_key });
        expect(runningStatus.runtime_session).toMatchObject({
          lifecycle_status: "running",
          runtime_status: "running",
          terminal: false,
        });
        const completed = await client.request<{ status?: string }>(
          "agent.wait",
          { runId: firstSpawn.runId, timeoutMs: 120_000 },
          { timeoutMs: 125_000 },
        );
        expect(completed.status, instance.logs()).toBe("ok");

        const listed = await client.request<{ sessions?: Array<{ session_key?: string }> }>(
          "sessions_list",
          {},
        );
        await vi.waitFor(
          async () => {
            const nativeSession = await client.request<{ messages?: unknown[] }>("sessions.get", {
              sessionKey: firstSpawn.session_key,
              limit: 1,
            });
            expect(nativeSession.messages?.length).toBeGreaterThan(0);
            const nativeHistory = await client.request<{ messages?: unknown[] }>("chat.history", {
              sessionKey: firstSpawn.session_key,
              limit: 20,
            });
            expect(JSON.stringify(nativeHistory.messages)).toContain(CHILD_RESULT);
          },
          { interval: 50, timeout: 30_000 },
        );
        let status: {
          session_key?: string;
          runtime_session?: {
            key?: string;
            lifecycle_status?: string;
            runtime_status?: string;
            terminal?: boolean;
          } | null;
        };
        let history: { session_key?: string; messages?: unknown[] };
        try {
          status = await client.request("sessions_status", { session_key: firstSpawn.session_key });
          history = await client.request("sessions_history", {
            sessionKey: firstSpawn.session_key,
            limit: 20,
            includeTools: true,
          });
        } catch (error) {
          throw new Error(`canonical session reads failed: ${String(error)}\n${instance.logs()}`, {
            cause: error,
          });
        }
        expect(listed.sessions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ session_key: firstSpawn.session_key }),
          ]),
        );
        expect(status.session_key).toBe(firstSpawn.session_key);
        expect(status.runtime_session).toMatchObject({
          key: firstSpawn.session_key,
          lifecycle_status: "completed",
          runtime_status: "ok",
          terminal: true,
        });
        expect(history.session_key).toBe(firstSpawn.session_key);
        expect(JSON.stringify(history.messages)).toContain(CHILD_RESULT);
        expect(modelServer.requests.filter((body) => body.includes(taskMarker))).toHaveLength(1);
        expect(
          (await secondPrincipalClient.request<{ sessions?: unknown[] }>("sessions_list", {}))
            .sessions,
        ).toEqual([]);
        await expect(
          secondPrincipalClient.request("sessions_status", {
            session_key: firstSpawn.session_key,
          }),
        ).rejects.toThrow(/different authenticated principal/i);
        await expect(
          client.request("sessions_spawn", {
            ...spawnParams,
            client_request_id: `consumed-${probeId}`,
            idempotency_key: `consumed-idem-${probeId}`,
            metadata: {
              ...metadata,
              client_request_id: `consumed-${probeId}`,
              idempotency_key: `consumed-idem-${probeId}`,
            },
          }),
        ).rejects.toThrow(/not active|reserved or consumed/i);

        const failureAcquireParams = {
          ...acquireParams,
          client_lease_id: `lease-failure-${probeId}`,
          idempotency_key: `acquire-failure-${probeId}`,
          run_id: `run-failure-${probeId}`,
          transition_id: `transition-failure-${probeId}`,
        };
        const failureLease = await client.request<{ gateway_lease_id: string }>(
          "subagents.allowLease.acquire",
          failureAcquireParams,
        );
        const failureTask = `Trigger the isolated failure marker ${FAILURE_MARKER}`;
        const failureMetadata = {
          ...metadata,
          run_id: failureAcquireParams.run_id,
          transition_id: failureAcquireParams.transition_id,
          client_request_id: `spawn-failure-${probeId}`,
          idempotency_key: `spawn-failure-idem-${probeId}`,
          task_digest: sha256(failureTask),
        };
        const failureSpawn = await client.request<{ runId: string; session_key: string }>(
          "sessions_spawn",
          {
            ...spawnParams,
            task: failureTask,
            taskName: "agentic-os-real-gateway-failure-probe",
            gateway_lease_id: failureLease.gateway_lease_id,
            client_request_id: failureMetadata.client_request_id,
            idempotency_key: failureMetadata.idempotency_key,
            metadata: failureMetadata,
          },
        );
        const failed = await client.request<{ status?: string }>(
          "agent.wait",
          { runId: failureSpawn.runId, timeoutMs: 120_000 },
          { timeoutMs: 125_000 },
        );
        expect(failed.status, instance.logs()).toBe("error");
        const failedStatus = await client.request<{
          runtime_session?: { lifecycle_status?: string; runtime_status?: string };
        }>("sessions_status", { session_key: failureSpawn.session_key });
        expect(failedStatus.runtime_session).toMatchObject({
          lifecycle_status: "failed",
          runtime_status: "error",
        });
        expect(modelServer.requests.filter((body) => body.includes(FAILURE_MARKER))).toHaveLength(
          1,
        );

        const failureReleaseParams = {
          client_lease_id: failureAcquireParams.client_lease_id,
          release_idempotency_key: `release-failure-${probeId}`,
          run_id: failureAcquireParams.run_id,
          phase: failureAcquireParams.phase,
          transition_id: failureAcquireParams.transition_id,
          agent_id: failureAcquireParams.agent_id,
          requester_agent_id: failureAcquireParams.requester_agent_id,
          gateway_lease_id: failureLease.gateway_lease_id,
        };
        expect(
          (
            await client.request<{ released?: boolean }>(
              "subagents.allowLease.release",
              failureReleaseParams,
            )
          ).released,
        ).toBe(true);
        const releaseParams = {
          client_lease_id: acquireParams.client_lease_id,
          release_idempotency_key: `release-${probeId}`,
          run_id: acquireParams.run_id,
          phase: acquireParams.phase,
          transition_id: acquireParams.transition_id,
          agent_id: acquireParams.agent_id,
          requester_agent_id: acquireParams.requester_agent_id,
          gateway_lease_id: firstLease.gateway_lease_id,
        };
        const released = await client.request<{ released?: boolean; gateway_lease_id?: string }>(
          "subagents.allowLease.release",
          releaseParams,
        );
        expect(released.released).toBe(true);
        const duplicateRelease = await client.request<{
          released?: boolean;
          gateway_lease_id?: string;
        }>("subagents.allowLease.release", releaseParams);
        expect(duplicateRelease).toEqual(released);
        expect(
          (await client.request<{ leases?: unknown[] }>("subagents.allowLease.status", {})).leases,
        ).toEqual([]);
        await expect(
          client.request("sessions_spawn", {
            ...spawnParams,
            client_request_id: `released-${probeId}`,
            idempotency_key: `released-idem-${probeId}`,
            metadata: {
              ...metadata,
              client_request_id: `released-${probeId}`,
              idempotency_key: `released-idem-${probeId}`,
            },
          }),
        ).rejects.toThrow();

        await writeEvidenceIfRequested({
          catalog,
          childSessionKey: firstSpawn.session_key,
          childRunId: firstSpawn.runId,
          gatewayLeaseId: firstLease.gateway_lease_id,
          taskMarker,
          history,
          modelRequestCount: modelServer.requests.length,
          agenticAdapterProof,
        });
      } finally {
        await Promise.allSettled([
          disconnectGatewayClient(secondPrincipalClient),
          disconnectGatewayClient(readOnlyClient),
          disconnectGatewayClient(writeOnlyClient),
          disconnectGatewayClient(client),
        ]);
      }
    },
  );
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
      entries: {
        main: { default: true, subagents: { allowAgents: [] } },
        worker: {},
      },
    },
    tools: { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        "agentic-os-probe": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "agentic-os-probe",
              name: "agentic-os-probe",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
}

async function runAgenticAdapterReleaseProbe(params: {
  client: { request: <T>(method: string, params: Record<string, unknown>) => Promise<T> };
  runtimeMethods: Array<{ name?: string; parameters?: string[] }>;
  probeId: string;
}): Promise<AgenticAdapterProof | undefined> {
  const script = process.env.AGENTIC_OS_REAL_ADAPTER_PROBE_SCRIPT?.trim();
  if (!script) {
    return undefined;
  }
  const child = spawnProcess("python3", [script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const owner = {
    client_lease_id: `adapter-lease-${params.probeId}`,
    run_id: `adapter-run-${params.probeId}`,
    phase: "phase-adapter-release",
    transition_id: `adapter-transition-${params.probeId}`,
    agent_id: "worker",
    requester_agent_id: "main",
  };
  child.stdin.write(
    `${JSON.stringify({
      catalog: { tools: params.runtimeMethods },
      acquire_params: {
        ...owner,
        idempotency_key: `adapter-acquire-${params.probeId}`,
        ttl_ms: 60_000,
      },
      release_params: {
        ...owner,
        release_idempotency_key: `adapter-release-${params.probeId}`,
      },
    })}\n`,
  );

  let result: AgenticAdapterProof | undefined;
  for await (const line of lines) {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === "rpc") {
      const method = message.method;
      const rpcParams = message.params;
      if (
        typeof method !== "string" ||
        !rpcParams ||
        typeof rpcParams !== "object" ||
        Array.isArray(rpcParams)
      ) {
        throw new Error("Agentic adapter probe emitted an invalid RPC request");
      }
      try {
        const payload = await params.client.request<Record<string, unknown>>(
          method,
          rpcParams as Record<string, unknown>,
        );
        child.stdin.write(`${JSON.stringify({ ok: true, payload })}\n`);
      } catch (error) {
        child.stdin.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
      }
      continue;
    }
    if (message.type === "result") {
      const proofKeys: Array<keyof AgenticAdapterProof> = [
        "agentic_adapter_live_catalog",
        "agentic_adapter_release_succeeded",
        "agentic_adapter_duplicate_release_parity",
        "agentic_adapter_release_metadata_parity",
        "agentic_adapter_post_release_absent",
      ];
      if (!proofKeys.every((key) => message[key] === true)) {
        throw new Error("Agentic adapter probe omitted a required proof");
      }
      result = Object.fromEntries(proofKeys.map((key) => [key, true])) as AgenticAdapterProof;
      continue;
    }
    if (message.type === "error") {
      throw new Error(`Agentic adapter probe failed: ${String(message.error)}`);
    }
    throw new Error("Agentic adapter probe emitted an unknown message");
  }
  const [exitCode, signal] = await exit;
  if (exitCode !== 0 || signal || !result) {
    throw new Error(
      `Agentic adapter probe did not complete: exit=${String(exitCode)} signal=${String(signal)} stderr_sha256=${sha256(stderr)}`,
    );
  }
  return result;
}

async function startMockModelServer(): Promise<MockModelServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    void handleModelRequest(request, response, requests);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function handleModelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: string[],
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "agentic-os-probe", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  requests.push(body);
  if (body.includes(FAILURE_MARKER)) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { type: "invalid_request_error", code: "fixture_failure", message: "failed" },
      }),
    );
    return;
  }
  await delay(750);
  writeModelResponse(response);
}

function writeModelResponse(response: ServerResponse): void {
  const message = {
    type: "message",
    id: "agentic-os-real-child-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: CHILD_RESULT, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: CHILD_RESULT,
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text: CHILD_RESULT,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "agentic-os-real-child-response",
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeEvidenceIfRequested(params: {
  catalog: unknown;
  childSessionKey: string;
  childRunId: string;
  gatewayLeaseId: string;
  taskMarker: string;
  history: unknown;
  modelRequestCount: number;
  agenticAdapterProof?: AgenticAdapterProof;
}) {
  const evidenceFile = process.env.AGENTIC_OS_REAL_GATEWAY_EVIDENCE_FILE?.trim();
  if (!evidenceFile) {
    return;
  }
  if (!params.agenticAdapterProof) {
    throw new Error("authoritative evidence requires the Agentic adapter release proof");
  }
  const sourcePaths = [
    "src/gateway/agentic-os-runtime-contract.ts",
    "src/gateway/server-methods/agentic-os-runtime-contract.ts",
    "src/agents/subagent-spawn.ts",
    "test/agentic-os-runtime-contract.e2e.test.ts",
  ];
  const sources = await Promise.all(
    sourcePaths.map(async (sourcePath) => ({
      path: sourcePath,
      sha256: sha256(await readFile(path.resolve(sourcePath))),
    })),
  );
  const runtimeMethods =
    params.catalog && typeof params.catalog === "object"
      ? (params.catalog as { runtimeMethods?: unknown }).runtimeMethods
      : undefined;
  const payload = {
    status: "pass",
    probe: "agentic-os-real-gateway-runtime-contract-v1",
    openclaw_head_sha: process.env.AGENTIC_OS_EXPECTED_OPENCLAW_HEAD ?? "unknown",
    authenticated_gateway: true,
    static_allow_agents_wildcard: false,
    effective_allow_lease: true,
    runtime_catalog_discovered: true,
    read_only_acquire_rejected: true,
    wrong_lease_rejected: true,
    cross_principal_lease_hidden: true,
    cross_principal_spawn_rejected: true,
    cross_principal_sessions_hidden: true,
    cross_principal_status_rejected: true,
    released_lease_spawn_rejected: true,
    canonical_session_observed: true,
    lifecycle_running_observed: true,
    lifecycle_completed_observed: true,
    lifecycle_failure_observed: true,
    duplicate_lease_identity_parity: true,
    duplicate_spawn_identity_parity: true,
    duplicate_release_identity_parity: true,
    ...params.agenticAdapterProof,
    child_completed: true,
    child_result_sha256: sha256(CHILD_RESULT),
    child_session_key_sha256: sha256(params.childSessionKey),
    child_run_id_sha256: sha256(params.childRunId),
    gateway_lease_id_sha256: sha256(params.gatewayLeaseId),
    task_marker_sha256: sha256(params.taskMarker),
    history_response_sha256: sha256(JSON.stringify(params.history)),
    model_request_count: params.modelRequestCount,
    runtime_methods_sha256: sha256(JSON.stringify(runtimeMethods)),
    sources,
  };
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

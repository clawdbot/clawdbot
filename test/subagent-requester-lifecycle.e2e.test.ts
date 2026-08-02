// Real-runtime proof for #118018: a parent reset between handoff admission
// and child completion must fence the stale completion out of the
// replacement lifecycle instead of delivering it.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const E2E_TIMEOUT_MS = 400_000;
const TEST_API_KEY = "test-token-placeholder";
const MODEL_ID = "proof-model";
const MODEL_REF = `proof/${MODEL_ID}`;
const CHILD_TASK = "PROOF_CHILD_TASK_7f3a";
const CHILD_RESULT = "PROOF_CHILD_RESULT_7f3a";
const PARENT_DONE = "PROOF_PARENT_DONE_7f3a";
const WAKE_MARKER = "Every subagent spawned from this session has now settled";

type MockModelRequest = {
  body: Record<string, unknown>;
};

type MockModelServer = {
  baseUrl: string;
  requests: MockModelRequest[];
  childRequestSeen: () => Promise<void>;
  releaseChild: () => void;
  stop: () => Promise<void>;
};

function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function textResponseEvents(sequence: number, text: string): Array<Record<string, unknown>> {
  const messageId = `msg_proof_${sequence}`;
  const responseId = `resp_proof_${sequence}`;
  const message = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

function spawnToolCallEvents(
  callId: string,
  name: string,
  argumentsJson: string,
): Array<Record<string, unknown>> {
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: callId,
        call_id: callId,
        name,
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: callId,
      output_index: 0,
      delta: argumentsJson,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: callId,
      output_index: 0,
      arguments: argumentsJson,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: callId, call_id: callId, name },
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${callId}`,
        status: "completed",
        output: [{ type: "function_call", id: callId, call_id: callId, name }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

function writeSse(res: ServerResponse, events: Array<Record<string, unknown>>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function requestText(request: MockModelRequest): string {
  return JSON.stringify(request.body);
}

function requestBodiesContaining(server: MockModelServer, marker: string): MockModelRequest[] {
  return server.requests.filter((request) => requestText(request).includes(marker));
}

async function waitFor<T>(
  label: string,
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 90_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startMockModelServer(): Promise<MockModelServer> {
  const requests: MockModelRequest[] = [];
  let releaseChild: () => void = () => {};
  let childReleasePromise = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let parentTurnSpawned = false;
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: MODEL_ID, object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const body = await readJsonRequest(req);
      const record = { body };
      requests.push(record);
      const text = JSON.stringify(body);
      const classification = text.includes(WAKE_MARKER)
        ? "wake"
        : text.includes("[Inter-session message] sourceSession=agent:main:subagent:")
          ? "child"
          : requests.length === 1
            ? "parent"
            : "parent-text";
      console.log(
        `[proof:model-request:${requests.length}] ${classification} subagentKey=${text.includes(
          "agent:main:subagent:",
        )} taskBlock=${text.includes("[Subagent Task]")} ${text.slice(0, 160)}`,
      );
      if (classification === "child") {
        await childReleasePromise;
        writeSse(res, textResponseEvents(requests.length, CHILD_RESULT));
        return;
      }
      if (classification === "wake") {
        writeSse(res, textResponseEvents(requests.length, "PROOF_WAKE_ACK"));
        return;
      }
      if (!parentTurnSpawned) {
        parentTurnSpawned = true;
        const argumentsJson = JSON.stringify({
          task: `Reply exactly ${CHILD_RESULT} and nothing else.`,
          taskName: "proof_child",
          cleanup: "keep",
          context: "isolated",
        });
        writeSse(
          res,
          spawnToolCallEvents(`call_spawn_${requests.length}`, "sessions_spawn", argumentsJson),
        );
        return;
      }
      if (requests.length === 2) {
        writeSse(
          res,
          spawnToolCallEvents(
            `call_bash_${requests.length}`,
            "bash",
            JSON.stringify({ command: "sleep 25", yieldMs: 40_000 }),
          ),
        );
        return;
      }
      writeSse(res, textResponseEvents(requests.length, "PROOF_PARENT_SAW_CHILD"));
    })().catch(() => {
      if (!res.writableEnded) {
        res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock model server did not bind");
  }
  let stopped = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    childRequestSeen: async () => {
      const started = Date.now();
      while (Date.now() - started < 90_000) {
        if (
          requests.some((request) =>
            requestText(request).includes(
              "[Inter-session message] sourceSession=agent:main:subagent:",
            ),
          )
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("child model request never arrived");
    },
    releaseChild: () => {
      childReleasePromise = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      releaseChild();
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function proofConfig(workspace: string, baseUrl: string): OpenClawConfig {
  return {
    plugins: { enabled: false },
    tools: { allow: ["sessions_spawn", "bash"] },
    models: {
      mode: "replace",
      providers: {
        proof: {
          baseUrl: `${baseUrl}/v1`,
          apiKey: TEST_API_KEY,
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: MODEL_ID,
              name: MODEL_ID,
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
    agents: {
      defaults: {
        workspace,
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" }, params: { maxTokens: 1024 } } },
        sandbox: { mode: "off" },
        subagents: {
          allowAgents: ["*"],
          runTimeoutSeconds: 120,
          announceTimeoutMs: 60_000,
          archiveAfterMinutes: 60,
        },
      },
    },
  };
}

type RegistryRow = {
  runId: string;
  taskName: string | undefined;
  wakeStatus: string | undefined;
  lifecycleMismatch: string | undefined;
  deliveryStatus: string | undefined;
  enqueuedAt: number | undefined;
  deliveredAt: number | undefined;
  announcedAt: number | undefined;
  lastError: string | undefined;
  endedAt: number | undefined;
  cleanupCompletedAt: number | undefined;
  payloadPresent: boolean | undefined;
};

function readRegistryRows(stateDbPath: string, requesterSessionKey: string): RegistryRow[] {
  const db = new DatabaseSync(stateDbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT run_id, requester_session_key, payload_json FROM subagent_runs WHERE requester_session_key = ?",
      )
      .all(requesterSessionKey) as Array<{
      run_id: string;
      requester_session_key: string;
      payload_json: string;
    }>;
    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as {
        taskName?: string;
        execution?: { endedAt?: number };
        cleanupCompletedAt?: number;
        delivery?: {
          status?: string;
          deliveredAt?: number;
          announcedAt?: number;
          enqueuedAt?: number;
          payload?: unknown;
        };
        requesterSettleWake?: {
          status?: string;
          lifecycleMismatch?: string;
          lastError?: string;
        };
      };
      return {
        runId: row.run_id,
        taskName: payload.taskName,
        wakeStatus: payload.requesterSettleWake?.status,
        lifecycleMismatch: payload.requesterSettleWake?.lifecycleMismatch,
        deliveryStatus: payload.delivery?.status,
        enqueuedAt: payload.delivery?.enqueuedAt,
        deliveredAt: payload.delivery?.deliveredAt,
        announcedAt: payload.delivery?.announcedAt,
        lastError: payload.requesterSettleWake?.lastError,
        endedAt: payload.execution?.endedAt,
        cleanupCompletedAt: payload.cleanupCompletedAt,
        payloadPresent: payload.delivery?.payload !== undefined,
      };
    });
  } finally {
    db.close();
  }
}

function readParentLifecycleRevision(stateDir: string, sessionKey: string): string | undefined {
  const agentDbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  if (!existsSync(agentDbPath)) {
    return undefined;
  }
  const db = new DatabaseSync(agentDbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey) as { entry_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    const entry = JSON.parse(row.entry_json) as { lifecycleRevision?: string };
    return entry.lifecycleRevision;
  } finally {
    db.close();
  }
}

const instances: OpenClawTestInstance[] = [];
const cleanupDirs: string[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.all(modelServers.splice(0).map((server) => server.stop()));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("requester lifecycle fence real-runtime proof", () => {
  async function startProofRuntime(): Promise<{
    instance: OpenClawTestInstance;
    modelServer: MockModelServer;
    sessionKey: string;
    fixtureDir: string;
  }> {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-lifecycle-fence-"));
    cleanupDirs.push(fixtureDir);
    const workspace = path.join(fixtureDir, "workspace");
    await mkdir(workspace, { recursive: true });
    const modelServer = await startMockModelServer();
    modelServers.push(modelServer);
    const port = await getFreeGatewayPort();
    const config = proofConfig(workspace, modelServer.baseUrl);
    const instance = await createOpenClawTestInstance({
      name: "requester-lifecycle-fence-proof",
      port,
      config,
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_SKIP_CRON: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    instances.push(instance);
    await instance.startGateway();
    const sessionKey = `agent:main:proof-${randomUUID().slice(0, 8)}`;
    return { instance, modelServer, sessionKey, fixtureDir };
  }

  async function connectClient(instance: OpenClawTestInstance) {
    return await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      requestTimeoutMs: 120_000,
    });
  }

  async function startParentTurn(
    client: Awaited<ReturnType<typeof connectClient>>,
    sessionKey: string,
  ): Promise<Promise<unknown>> {
    const pending = client.request<{ result?: unknown }>(
      "agent",
      {
        sessionKey,
        idempotencyKey: `proof-${randomUUID()}`,
        deliver: false,
        timeout: 120,
        message: [
          `Spawn one subagent with task text that contains ${CHILD_TASK}.`,
          "Use the sessions_spawn tool with taskName proof_child and cleanup keep.",
          `After the spawn is accepted, reply exactly ${PARENT_DONE}.`,
        ].join("\n"),
      },
      { expectFinal: true, timeoutMs: 120_000 },
    );
    return pending;
  }

  async function collectOutcome(
    instance: OpenClawTestInstance,
    modelServer: MockModelServer,
    sessionKey: string,
  ) {
    const stateDbPath = path.join(instance.stateDir, "state", "openclaw.sqlite");
    return {
      parentLifecycleRevision: readParentLifecycleRevision(instance.stateDir, sessionKey),
      wakeRequestCount: requestBodiesContaining(modelServer, WAKE_MARKER).length,
      runs: readRegistryRows(stateDbPath, sessionKey),
    };
  }

  it(
    "fences the stale completion when the parent lifecycle is replaced before the child settles",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { instance, modelServer, sessionKey, fixtureDir } = await startProofRuntime();
      const client = await connectClient(instance);
      try {
        const parentTurn = startParentTurn(client, sessionKey);
        parentTurn.catch(() => undefined);
        await modelServer.childRequestSeen();

        const beforeReset = readParentLifecycleRevision(instance.stateDir, sessionKey);
        const resetResult = await client.request<{ ok?: boolean }>("sessions.reset", {
          key: sessionKey,
          reason: "reset",
        });
        expect(resetResult.ok ?? resetResult).toBeTruthy();

        modelServer.releaseChild();

        await waitFor(
          "child run ended",
          () => {
            const rows = readRegistryRows(
              path.join(instance.stateDir, "state", "openclaw.sqlite"),
              sessionKey,
            );
            return rows.some((row) => row.endedAt !== undefined) ? rows : undefined;
          },
          240_000,
        );

        await new Promise((resolve) => setTimeout(resolve, 20_000));
        console.log(
          `[proof:fenced-before-turn2] ${JSON.stringify(
            await collectOutcome(instance, modelServer, sessionKey),
          )}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 10_000));

        const outcome = await collectOutcome(instance, modelServer, sessionKey);
        await writeFile(
          path.join(fixtureDir, "proof-fenced-outcome.json"),
          JSON.stringify(outcome, null, 2),
        );
        console.log(`[proof:fenced] ${JSON.stringify(outcome)}`);
        const afterReset = readParentLifecycleRevision(instance.stateDir, sessionKey);
        expect(afterReset).toBeTruthy();
        expect(afterReset).not.toBe(beforeReset);
        expect(outcome.wakeRequestCount).toBe(0);
        expect(outcome.runs.length).toBeGreaterThan(0);
        for (const run of outcome.runs) {
          expect(run.deliveredAt).toBeUndefined();
          expect(run.announcedAt).toBeUndefined();
        }
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );

  it(
    "delivers the completion to the unchanged lifecycle as the control",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { instance, modelServer, sessionKey, fixtureDir } = await startProofRuntime();
      const client = await connectClient(instance);
      try {
        await startParentTurn(client, sessionKey);
        await modelServer.childRequestSeen();

        modelServer.releaseChild();

        await waitFor(
          "child run ended",
          () => {
            const rows = readRegistryRows(
              path.join(instance.stateDir, "state", "openclaw.sqlite"),
              sessionKey,
            );
            return rows.some((row) => row.endedAt !== undefined) ? rows : undefined;
          },
          240_000,
        );

        await client
          .request<{ result?: unknown }>(
            "agent",
            {
              sessionKey,
              idempotencyKey: `proof-followup-${randomUUID()}`,
              deliver: false,
              timeout: 120,
              message: "Continue.",
            },
            { expectFinal: true, timeoutMs: 120_000 },
          )
          .catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        const outcome = await collectOutcome(instance, modelServer, sessionKey);
        await writeFile(
          path.join(fixtureDir, "proof-control-outcome.json"),
          JSON.stringify(outcome, null, 2),
        );
        console.log(`[proof:control] ${JSON.stringify(outcome)}`);
        expect(outcome.wakeRequestCount).toBe(0);
        expect(outcome.runs.length).toBeGreaterThan(0);
        for (const run of outcome.runs) {
          expect(run.lifecycleMismatch).toBeUndefined();
          expect(run.deliveryStatus).not.toBe("suspended");
          expect(run.payloadPresent).toBe(true);
        }
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );
});

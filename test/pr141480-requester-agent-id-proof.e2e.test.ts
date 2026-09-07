// E2E proof for PR #141480: on a real multi-agent Gateway, a subagent completion
// is delivered to the requester agent that spawn recorded, even when the requester
// session key carries no agent segment.
//
// The failure this pins: completion dispatch used to build its announce parameters
// without the captured requesterAgentId, so announce re-derived the owner from the
// unscoped key alone, reached default agent selection on a two-agent roster, and
// threw AGENT_SELECTION_REQUIRED into a catch that leaves the run retryable.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSubagentSessionEntry } from "../src/agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../src/agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { writeOpenAiResponsesSse } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const MODEL_REF = "pr141480/pr141480";
// No "agent:<id>:" segment. resolveRequesterStoreKey only short-circuits on a key
// that already carries one, so this is the shape that forces owner resolution.
const UNSCOPED_REQUESTER_KEY = "pr141480-requester";
const REQUESTER_AGENT_ID = "beta";
const OTHER_AGENT_ID = "alpha";
const PARENT_PROMPT = "PR141480 parent: spawn one worker and finish without waiting.";
const CHILD_TASK = "PR141480 child task: reply with the agreed child token.";
const CHILD_MARKER = "PR141480-CHILD-OK";
const ANNOUNCE_FAILURE_MARKER = "Subagent announce failed";
// The restored-row lane. A row written before requester keys were agent-scoped keeps
// an unscoped requesterSessionKey, which is the state resolveSubagentRequesterAgentId
// exists for ("legacy rows that predate requesterAgentId").
const LEGACY_RUN_ID = "run-pr141480-legacy";
const LEGACY_REQUESTER_KEY = "pr141480-legacy-requester";
const LEGACY_CHILD_RESULT = "PR141480-LEGACY-CHILD-RESULT";

type SseEvent = Record<string, unknown>;

type ProofModelServer = {
  bodies: () => readonly string[];
  close: () => Promise<void>;
  countRequestsContaining: (marker: string) => number;
  requestCount: () => number;
  url: string;
};

const instances: OpenClawTestInstance[] = [];
const modelServers: ProofModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("PR141480 requester agent id survives completion dispatch", () => {
  it(
    "delivers a child completion to the recorded requester agent for an unscoped key",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startProofModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "pr141480-requester-agent-id",
        config: createTestConfig(modelServer.url),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      instances.push(instance);

      // (b) The requester session key carries no agent segment.
      expect(UNSCOPED_REQUESTER_KEY).not.toMatch(/^agent:/);
      expect(UNSCOPED_REQUESTER_KEY.split(":")[0]).not.toBe("agent");

      // (a) The Gateway boots on a two-agent roster with no default owner. Assert on
      // the config file the Gateway actually loaded, not on the object we passed in.
      const bootedConfig = JSON.parse(
        await readFile(instance.configPath, "utf8"),
      ) as OpenClawConfig;
      const roster = bootedConfig.agents?.list ?? [];
      expect(roster.map((entry) => entry.id)).toEqual([OTHER_AGENT_ID, REQUESTER_AGENT_ID]);
      expect(roster.filter((entry) => entry.default === true)).toEqual([]);
      expect(bootedConfig.agents?.ownership).toBe("explicit");

      instance.state.applyEnv();
      try {
        await writeSubagentSessionEntry({
          stateDir: instance.stateDir,
          agentId: REQUESTER_AGENT_ID,
          sessionKey: UNSCOPED_REQUESTER_KEY,
          sessionId: "pr141480-requester-session",
          defaultSessionId: "pr141480-requester-session",
        });
      } finally {
        closeOpenClawStateDatabaseForTest();
      }

      await instance.startGateway();
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
      });
      try {
        const parent = client.request(
          "agent",
          {
            sessionKey: UNSCOPED_REQUESTER_KEY,
            agentId: REQUESTER_AGENT_ID,
            idempotencyKey: "pr141480-parent-turn",
            message: PARENT_PROMPT,
            deliver: false,
          },
          { expectFinal: true },
        );
        void parent.catch(() => {});
        // The child token only ever appears in a request body once the completion has
        // been announced back into the requester's session, so this is delivery
        // evidence rather than a spawn acknowledgement.
        await vi.waitFor(
          () => expect(modelServer.countRequestsContaining(CHILD_MARKER)).toBeGreaterThan(0),
          { interval: 50, timeout: 90_000 },
        );
        await Promise.allSettled([parent]);
      } finally {
        await disconnectGatewayClient(client);
        await instance.stopGateway();
      }

      const logs = instance.logs();
      instance.state.applyEnv();
      try {
        const runs = [...loadSubagentRegistryFromSqlite().values()];
        expect(runs, logs).toHaveLength(1);
        const run = runs[0]!;
        // (c) Spawn persisted the owner. Proven from the durable row, not assumed.
        expect(run.requesterAgentId, logs).toBe(REQUESTER_AGENT_ID);
        expect(run.requesterSessionKey, logs).toContain(UNSCOPED_REQUESTER_KEY);
        // (d) The child completed.
        expect(run.execution.status, logs).toBe("terminal");
        expect(run.execution.outcome, logs).toMatchObject({ status: "ok" });
        // (e) The completion reached the requester and nothing is left to retry.
        expect(run.delivery?.status, logs).toBe("delivered");
        expect(run.requesterSettleWake, logs).toBeUndefined();
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
      expect(logs).not.toContain(ANNOUNCE_FAILURE_MARKER);
    },
  );

  it(
    "settles a restored run whose requester key carries no agent segment",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startProofModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "pr141480-legacy-unscoped-requester",
        config: createTestConfig(modelServer.url),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      instances.push(instance);

      expect(LEGACY_REQUESTER_KEY).not.toMatch(/^agent:/);

      instance.state.applyEnv();
      try {
        const endedAt = Date.now();
        const restored: SubagentRunRecord = {
          runId: LEGACY_RUN_ID,
          childSessionKey: `agent:${REQUESTER_AGENT_ID}:subagent:pr141480-legacy`,
          requesterSessionKey: LEGACY_REQUESTER_KEY,
          requesterDisplayKey: LEGACY_REQUESTER_KEY,
          requesterAgentId: REQUESTER_AGENT_ID,
          task: "PR141480 legacy restored completion",
          cleanup: "keep",
          createdAt: endedAt - 2_000,
          endedReason: "subagent-complete",
          execution: {
            status: "terminal",
            startedAt: endedAt - 1_000,
            endedAt,
            outcome: { status: "ok" },
          },
          expectsCompletionMessage: true,
          completion: { required: true, resultText: LEGACY_CHILD_RESULT, capturedAt: endedAt },
          delivery: { status: "pending" },
        };
        saveSubagentRegistryToSqlite(new Map([[restored.runId, restored]]));
        await writeSubagentSessionEntry({
          stateDir: instance.stateDir,
          agentId: REQUESTER_AGENT_ID,
          sessionKey: LEGACY_REQUESTER_KEY,
          sessionId: "pr141480-legacy-session",
          defaultSessionId: "pr141480-legacy-session",
        });
        // Restore prunes a row whose child session entry is gone, so the row has to
        // look like what it is: a real child that ended and never delivered.
        await writeSubagentSessionEntry({
          stateDir: instance.stateDir,
          agentId: REQUESTER_AGENT_ID,
          sessionKey: restored.childSessionKey,
          sessionId: "pr141480-legacy-child-session",
          defaultSessionId: "pr141480-legacy-child-session",
        });
        // The fix can only pass on what the durable row actually carries, so prove the
        // round trip before the Gateway ever reads it.
        const seeded = loadSubagentRegistryFromSqlite().get(LEGACY_RUN_ID);
        expect(seeded?.requesterAgentId).toBe(REQUESTER_AGENT_ID);
        expect(seeded?.requesterSessionKey).toBe(LEGACY_REQUESTER_KEY);
        expect(seeded?.delivery?.status).toBe("pending");
      } finally {
        closeOpenClawStateDatabaseForTest();
      }

      await instance.startGateway();
      try {
        // Delivery evidence: the child's result only enters a model request body when
        // the completion has been announced into the requester's own session.
        await vi.waitFor(
          () =>
            expect(
              modelServer.countRequestsContaining(LEGACY_CHILD_RESULT),
              instance.logs(),
            ).toBeGreaterThan(0),
          { interval: 50, timeout: 25_000 },
        );
      } finally {
        await instance.stopGateway();
      }

      const logs = instance.logs();
      expect(logs).not.toContain(ANNOUNCE_FAILURE_MARKER);
      instance.state.applyEnv();
      try {
        const run = loadSubagentRegistryFromSqlite().get(LEGACY_RUN_ID);
        expect(run?.requesterAgentId, logs).toBe(REQUESTER_AGENT_ID);
        expect(run?.requesterSessionKey, logs).toBe(LEGACY_REQUESTER_KEY);
        expect(run?.delivery?.status, logs).toBe("delivered");
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: {
      // Explicit ownership is the supported multi-agent shape and is exactly the
      // state in which resolveDefaultAgentId cannot pick an owner.
      ownership: "explicit",
      list: [{ id: OTHER_AGENT_ID }, { id: REQUESTER_AGENT_ID }],
      defaults: {
        heartbeat: { every: "0m" },
        maxConcurrent: 8,
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: { profile: "coding" },
    models: {
      mode: "replace",
      providers: {
        pr141480: {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "pr141480",
              name: "pr141480",
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

let responseSequence = 0;

function buildAssistantEvents(text: string): SseEvent[] {
  const sequence = ++responseSequence;
  const responseId = `resp_pr141480_${sequence}`;
  const itemId = `msg_pr141480_${sequence}`;
  const part = { type: "output_text", text, annotations: [] };
  const item = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [part],
  };
  const position = { item_id: itemId, output_index: 0, content_index: 0 };
  return [
    {
      type: "response.created",
      response: { id: responseId, object: "response", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    { type: "response.content_part.added", ...position, part: { ...part, text: "" } },
    { type: "response.output_text.delta", ...position, delta: text },
    { type: "response.output_text.done", ...position, text },
    { type: "response.content_part.done", ...position, part },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    },
  ];
}

function buildToolCallEvents(name: string, args: Record<string, unknown>): SseEvent[] {
  const sequence = ++responseSequence;
  const responseId = `resp_pr141480_tool_${sequence}`;
  const itemId = `fc_pr141480_${sequence}`;
  const callId = `call_pr141480_${sequence}`;
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsText,
  };
  return [
    {
      type: "response.created",
      response: { id: responseId, object: "response", status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      arguments: argumentsText,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    },
  ];
}

async function startProofModelServer(): Promise<ProofModelServer> {
  const requestBodies: string[] = [];
  const server = createServer((request, response) => {
    void handleModelRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  async function handleModelRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "pr141480", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    }
    requestBodies.push(body);
    // The child turn carries the spawn task and no prior tool output.
    if (body.includes(CHILD_TASK) && !body.includes("function_call_output")) {
      writeOpenAiResponsesSse(response, buildAssistantEvents(CHILD_MARKER));
      return;
    }
    // The parent's first turn asks for one worker.
    if (body.includes(PARENT_PROMPT) && !body.includes("function_call_output")) {
      writeOpenAiResponsesSse(
        response,
        buildToolCallEvents("sessions_spawn", {
          task: CHILD_TASK,
          label: "pr141480-child",
          thread: false,
          mode: "run",
        }),
      );
      return;
    }
    writeOpenAiResponsesSse(response, buildAssistantEvents("PR141480-PARENT-OK"));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    bodies: () => requestBodies,
    countRequestsContaining: (marker) =>
      requestBodies.filter((entry) => entry.includes(marker)).length,
    requestCount: () => requestBodies.length,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

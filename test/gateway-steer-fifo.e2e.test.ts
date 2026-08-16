import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { GatewayClient, type GatewayClientOptions } from "../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { GatewayChatClient } from "../src/tui/gateway-chat.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

type FirstResponseKind = "final" | "sequential-tools" | "tool";
type ModelRequest = { body: Record<string, unknown> };
type MockModelServer = {
  baseUrl: string;
  releaseFirst: (kind: FirstResponseKind) => void;
  requests: ModelRequest[];
  stop: () => Promise<void>;
};
type AgentEvent = {
  runId?: string;
  stream?: string;
  data?: { phase?: string };
};
type GatewayFixture = {
  client: GatewayChatClient;
  diagnosticsClient: GatewayClient;
  instance: OpenClawTestInstance;
  modelServer: MockModelServer;
  events: AgentEvent[];
  chatErrors: Array<{ errorMessage?: string; runId?: string; state: "error" }>;
  chatFinalRunIds: string[];
  sessionKey: string;
  steeringTools?: SteeringToolsFixture;
};

type SteeringToolsFixture = {
  pluginDir: string;
  releasePath: string;
  tracePath: string;
};
type SteeringGateMode = "preflight" | "execute";

const TEST_TIMEOUT_MS = 180_000;
const WAIT_OPTS = { timeout: 30_000, interval: 20 } as const;
const STEERING_PLUGIN_ID = "gateway-steering-tools";
const STEERING_GATE_TOOL = "steering_gate";
const STEERING_TAIL_TOOL = "steering_tail";
const instances: OpenClawTestInstance[] = [];
const clients: GatewayChatClient[] = [];
const diagnosticsClients: GatewayClient[] = [];
const cleanupDirs: string[] = [];
const modelServers: MockModelServer[] = [];

async function collectCleanupFailures(
  tasks: Array<Promise<unknown>>,
  failures: unknown[],
): Promise<void> {
  const results = await Promise.allSettled(tasks);
  failures.push(
    ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  );
}

afterEach(async () => {
  const failures: unknown[] = [];
  await collectCleanupFailures(
    clients.splice(0).map((client) => client.stop()),
    failures,
  );
  await collectCleanupFailures(
    diagnosticsClients.splice(0).map((client) => client.stopAndWait()),
    failures,
  );
  await collectCleanupFailures(
    instances.splice(0).map((instance) => instance.cleanup()),
    failures,
  );
  await collectCleanupFailures(
    modelServers.splice(0).map((server) => server.stop()),
    failures,
  );
  await collectCleanupFailures(
    cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    failures,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Gateway steer FIFO cleanup failed");
  }
});

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function writeSse(res: ServerResponse, events: Record<string, unknown>[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function writeTextResponse(res: ServerResponse, requestIndex: number): void {
  const id = `msg_steer_fifo_${requestIndex}`;
  const text = `TURN_${requestIndex}_COMPLETE`;
  const message = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeSse(res, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp_steer_fifo_${requestIndex}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

function writeToolResponse(res: ServerResponse): void {
  const item = {
    type: "function_call",
    id: "fc_steer_fifo_status",
    call_id: "call_steer_fifo_status",
    name: "session_status",
    arguments: "{}",
    status: "completed",
  };
  writeSse(res, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_steer_fifo_tool",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

function writeSequentialToolsResponse(res: ServerResponse): void {
  const items = [
    {
      type: "function_call",
      id: "fc_steering_gate",
      call_id: "call_steering_gate",
      name: STEERING_GATE_TOOL,
      arguments: "{}",
      status: "completed",
    },
    {
      type: "function_call",
      id: "fc_steering_tail",
      call_id: "call_steering_tail",
      name: STEERING_TAIL_TOOL,
      arguments: "{}",
      status: "completed",
    },
  ];
  writeSse(res, [
    ...items.flatMap((item, outputIndex) => [
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", arguments: "" },
      },
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      },
      { type: "response.output_item.done", output_index: outputIndex, item },
    ]),
    {
      type: "response.completed",
      response: {
        id: "resp_steer_fifo_sequential_tools",
        status: "completed",
        output: items,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function startMockModelServer(): Promise<MockModelServer> {
  const requests: ModelRequest[] = [];
  const firstResponse = createDeferred();
  let firstResponseKind: FirstResponseKind = "final";
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "steer-fifo", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      requests.push({ body: await readJsonRequest(req) });
      const requestIndex = requests.length;
      if (requestIndex === 1) {
        await firstResponse.promise;
        if (res.destroyed) {
          return;
        }
        if (firstResponseKind === "tool") {
          writeToolResponse(res);
          return;
        }
        if (firstResponseKind === "sequential-tools") {
          writeSequentialToolsResponse(res);
          return;
        }
      }
      writeTextResponse(res, requestIndex);
    })().catch((error: unknown) => {
      if (!res.destroyed) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(error) } }));
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
    releaseFirst: (kind) => {
      firstResponseKind = kind;
      firstResponse.resolve();
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      firstResponse.resolve();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

async function writeSteeringToolsPlugin(
  fixtureDir: string,
  gateMode: SteeringGateMode,
): Promise<SteeringToolsFixture> {
  const pluginDir = path.join(fixtureDir, "steering-tools-plugin");
  const releasePath = path.join(fixtureDir, "steering-gate.release");
  const tracePath = path.join(fixtureDir, "steering-tools.trace");
  const preflightLines =
    gateMode === "preflight"
      ? [
          '    api.on("before_tool_call", async (event) => {',
          `      if (event.toolName !== ${JSON.stringify(STEERING_GATE_TOOL)}) return;`,
          `      await appendFile(${JSON.stringify(tracePath)}, "preflight-start\\n", "utf8");`,
          "      await waitForRelease();",
          `      await appendFile(${JSON.stringify(tracePath)}, "preflight-end\\n", "utf8");`,
          "    });",
        ]
      : [];
  const gateExecutionLines =
    gateMode === "execute"
      ? [
          `        await appendFile(${JSON.stringify(tracePath)}, "gate-execute-start\\n", "utf8");`,
          "        await waitForRelease();",
          `        await appendFile(${JSON.stringify(tracePath)}, "gate-execute-end\\n", "utf8");`,
        ]
      : [`        await appendFile(${JSON.stringify(tracePath)}, "gate-executed\\n", "utf8");`];
  await mkdir(pluginDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify({
        id: STEERING_PLUGIN_ID,
        name: "Gateway Steering Tools",
        activation: { onStartup: true },
        contracts: { tools: [STEERING_GATE_TOOL, STEERING_TAIL_TOOL] },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      })}\n`,
      "utf8",
    ),
    writeFile(
      path.join(pluginDir, "index.mjs"),
      [
        'import { access, appendFile } from "node:fs/promises";',
        "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
        "async function waitForRelease() {",
        "  const deadline = Date.now() + 15_000;",
        "  while (Date.now() < deadline) {",
        "    try {",
        `      await access(${JSON.stringify(releasePath)});`,
        "      return;",
        "    } catch (error) {",
        '      if (error?.code !== "ENOENT") throw error;',
        "    }",
        "    await sleep(20);",
        "  }",
        '  throw new Error("steering gate release timed out");',
        "}",
        "export default {",
        `  id: ${JSON.stringify(STEERING_PLUGIN_ID)},`,
        "  register(api) {",
        ...preflightLines,
        "    api.registerTool({",
        `      name: ${JSON.stringify(STEERING_GATE_TOOL)},`,
        '      label: "Steering Gate",',
        '      description: "Wait for the steering gateway test release file.",',
        '      parameters: { type: "object", properties: {}, additionalProperties: false },',
        '      executionMode: "sequential",',
        "      async execute() {",
        ...gateExecutionLines,
        '        return { content: [{ type: "text", text: "steering gate completed" }], details: {} };',
        "      },",
        "    });",
        "    api.registerTool({",
        `      name: ${JSON.stringify(STEERING_TAIL_TOOL)},`,
        '      label: "Steering Tail",',
        '      description: "Record if the steering tail executes unexpectedly.",',
        '      parameters: { type: "object", properties: {}, additionalProperties: false },',
        '      executionMode: "sequential",',
        "      async execute() {",
        `        await appendFile(${JSON.stringify(tracePath)}, "tail-executed\\n", "utf8");`,
        '        return { content: [{ type: "text", text: "steering tail executed" }], details: {} };',
        "      },",
        "    });",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    ),
  ]);
  return { pluginDir, releasePath, tracePath };
}

async function readTrace(tracePath: string): Promise<string[]> {
  try {
    return (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function createConfig(params: {
  fixtureDir: string;
  modelServer: MockModelServer;
  steeringTools?: SteeringToolsFixture;
}): OpenClawConfig {
  const provider = buildMockOpenAiResponsesProvider(
    `${params.modelServer.baseUrl}/v1`,
    "steer-fifo",
  );
  const steeringTools = params.steeringTools;
  return {
    plugins: steeringTools
      ? {
          enabled: true,
          allow: [STEERING_PLUGIN_ID],
          load: { paths: [steeringTools.pluginDir] },
          entries: { [STEERING_PLUGIN_ID]: { enabled: true } },
          slots: { memory: "none" },
        }
      : { slots: { memory: "none" } },
    agents: {
      defaults: {
        workspace: path.join(params.fixtureDir, "workspace"),
        model: { primary: provider.modelRef },
        models: {
          [provider.modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
        skills: [],
        skipBootstrap: true,
      },
      entries: {
        main: { default: true, model: { primary: provider.modelRef }, skills: [] },
      },
    },
    tools: steeringTools
      ? { profile: "minimal", alsoAllow: [STEERING_GATE_TOOL, STEERING_TAIL_TOOL] }
      : { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        [provider.providerId]: {
          ...provider.config,
          models: provider.config.models.map((model) =>
            Object.assign({}, model, { input: Array.from(model.input) }),
          ),
          request: { allowPrivateNetwork: true },
        },
      },
    },
    messages: { queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } } },
  };
}

async function connectDiagnosticsClient(instance: OpenClawTestInstance): Promise<GatewayClient> {
  let resolveHello!: () => void;
  let rejectHello!: (error: Error) => void;
  const hello = new Promise<void>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const gatewayUrl = new URL(instance.url);
  gatewayUrl.protocol = gatewayUrl.protocol === "wss:" ? "https:" : "http:";
  const options: GatewayClientOptions = {
    url: instance.url,
    origin: gatewayUrl.origin,
    token: "steer-fifo-token",
    clientName: GATEWAY_CLIENT_NAMES.TUI,
    clientDisplayName: "steer-fifo-e2e-diagnostics",
    mode: GATEWAY_CLIENT_MODES.UI,
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    caps: [
      GATEWAY_CLIENT_CAPS.AGENT_KIND,
      GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS,
      GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
    ],
    platform: process.platform,
    requestTimeoutMs: 30_000,
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
    onClose: (code, reason) => rejectHello(new Error(`Gateway closed ${code}: ${reason}`)),
  };
  const client = new GatewayClient(options);
  diagnosticsClients.push(client);
  client.start();
  await hello;
  return client;
}

async function createGatewayFixture(
  name: string,
  options: { withSteeringTools?: boolean; steeringGateMode?: SteeringGateMode } = {},
): Promise<GatewayFixture> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), `openclaw-${name}-`));
  cleanupDirs.push(fixtureDir);
  const steeringTools = options.withSteeringTools
    ? await writeSteeringToolsPlugin(fixtureDir, options.steeringGateMode ?? "preflight")
    : undefined;
  const modelServer = await startMockModelServer();
  modelServers.push(modelServer);
  const instance = await createOpenClawTestInstance({
    name,
    gatewayToken: "steer-fifo-token",
    config: createConfig({ fixtureDir, modelServer, steeringTools }),
    env: {
      OPENCLAW_LOG_LEVEL: "debug",
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    },
  });
  instances.push(instance);
  await instance.startGateway();
  const events: AgentEvent[] = [];
  const chatErrors: Array<{ errorMessage?: string; runId?: string; state: "error" }> = [];
  const chatFinalRunIds: string[] = [];
  const client = new GatewayChatClient({
    url: instance.url,
    token: "steer-fifo-token",
  });
  clients.push(client);
  client.onEvent = ({ event, payload }) => {
    if (event === "agent" && payload && typeof payload === "object") {
      const agentEvent = payload as AgentEvent;
      events.push(agentEvent);
    }
    if (event === "chat" && payload && typeof payload === "object") {
      const chat = payload as { errorMessage?: unknown; runId?: unknown; state?: unknown };
      if (chat.state === "error") {
        chatErrors.push({
          state: "error",
          ...(typeof chat.runId === "string" ? { runId: chat.runId } : {}),
          ...(typeof chat.errorMessage === "string"
            ? { errorMessage: chat.errorMessage.replaceAll("steer-fifo-token", "[REDACTED]") }
            : {}),
        });
      } else if (chat.state === "final" && typeof chat.runId === "string") {
        chatFinalRunIds.push(chat.runId);
      }
    }
  };
  client.start();
  await client.waitForReady();
  await client.subscribeSessionEvents();
  const diagnosticsClient = await connectDiagnosticsClient(instance);
  return {
    client,
    diagnosticsClient,
    instance,
    modelServer,
    events,
    chatErrors,
    chatFinalRunIds,
    sessionKey: `agent:main:${name}`,
    ...(steeringTools ? { steeringTools } : {}),
  };
}

async function sendChat(params: {
  fixture: GatewayFixture;
  message: string;
  runId: string;
}): Promise<{ runId: string; status?: string }> {
  return await params.fixture.client.sendChat({
    sessionKey: params.fixture.sessionKey,
    message: params.message,
    deliver: false,
    runId: params.runId,
  });
}

function redactedFixtureLogs(instance: OpenClawTestInstance): string {
  return instance
    .logs()
    .replaceAll("steer-fifo-token", "[REDACTED]")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(["']?apiKey["']?\s*[:=]\s*)["'][^"']+["']/giu, "$1[REDACTED]")
    .slice(-12_000);
}

async function sendHeldTurn(fixture: GatewayFixture) {
  const first = await sendChat({
    fixture,
    message: "INITIAL_HELD_TURN",
    runId: "initial-held-turn",
  });
  expect(first.status).toBe("started");
  try {
    await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(1), WAIT_OPTS);
  } catch (error) {
    throw new Error(
      `initial chat turn did not reach the mock provider\n` +
        `chat errors=${JSON.stringify(fixture.chatErrors)}\n` +
        redactedFixtureLogs(fixture.instance),
      { cause: error },
    );
  }
  return first;
}

async function queueSteer(fixture: GatewayFixture, marker = "QUEUED_STEER_A") {
  const baseline = await fixture.diagnosticsClient.request<{ lastSeq?: number }>(
    "diagnostics.stability",
    {
      type: "message.queued",
      limit: 1,
    },
  );
  const result = await sendChat({
    fixture,
    message: marker,
    runId: `run-${marker.toLowerCase()}`,
  });
  expect(result.status).toBe("started");
  await vi.waitFor(async () => {
    const snapshot = await fixture.diagnosticsClient.request<{
      events?: Array<{
        queueDepth?: number;
        source?: string;
        type?: string;
      }>;
    }>("diagnostics.stability", {
      type: "message.queued",
      sinceSeq: baseline.lastSeq ?? 0,
      limit: 20,
    });
    const dispatchQueueEvents = (snapshot.events ?? []).filter(
      (event) => event.type === "message.queued" && event.source === "followup-queue-steer",
    );
    expect(dispatchQueueEvents).not.toHaveLength(0);
    expect(fixture.modelServer.requests).toHaveLength(1);
  }, WAIT_OPTS);
  return result;
}

async function resolveUiSteerTarget(
  fixture: GatewayFixture,
  expectedChatRunId: string,
): Promise<{ expectedRunId: string; expectedLeafEntryId: string }> {
  let target: { expectedRunId: string; expectedLeafEntryId: string } | undefined;
  await vi.waitFor(async () => {
    const [sessions, history] = await Promise.all([
      fixture.diagnosticsClient.request<{
        sessions?: Array<{
          key?: string;
          hasActiveRun?: boolean;
          activeRunIds?: string[];
          activeLeafEntryId?: string | null;
        }>;
      }>("sessions.list", { includeGlobal: true, limit: 20 }),
      fixture.diagnosticsClient.request<{
        sessionInfo?: { activeRunIds?: string[]; activeLeafEntryId?: string | null };
        inFlightRun?: { runId?: string };
      }>("chat.history", { sessionKey: fixture.sessionKey, limit: 20 }),
    ]);
    const row = sessions.sessions?.find((candidate) => candidate.key === fixture.sessionKey);
    expect(row?.hasActiveRun).toBe(true);
    expect(row?.activeRunIds).toHaveLength(1);
    const expectedRunId = row?.activeRunIds?.[0];
    const expectedLeafEntryId = history.sessionInfo?.activeLeafEntryId?.trim();
    expect(expectedRunId).toBe(expectedChatRunId);
    expect(history.sessionInfo?.activeRunIds).toEqual([expectedRunId]);
    expect(history.inFlightRun?.runId).toBe(expectedRunId);
    expect(expectedLeafEntryId).toEqual(expect.any(String));
    if (row?.activeLeafEntryId) {
      expect(row.activeLeafEntryId).toBe(expectedLeafEntryId);
    }
    if (expectedRunId && expectedLeafEntryId) {
      target = { expectedRunId, expectedLeafEntryId };
    }
  }, WAIT_OPTS);
  if (!target) {
    throw new Error(`Gateway omitted the active UI steering identity for ${fixture.sessionKey}`);
  }
  return target;
}

async function queueExactUiSteer(params: {
  fixture: GatewayFixture;
  marker: string;
  target: { expectedRunId: string; expectedLeafEntryId: string };
}): Promise<string> {
  const runId = `run-${params.marker.toLowerCase()}`;
  const result = await params.fixture.diagnosticsClient.request<{
    runId?: string;
    status?: string;
  }>("chat.send", {
    sessionKey: params.fixture.sessionKey,
    message: params.marker,
    deliver: false,
    queueMode: "steer",
    ...params.target,
    idempotencyKey: runId,
  });
  expect(result).toMatchObject({ runId, status: "started" });
  expect(params.fixture.modelServer.requests).toHaveLength(1);
  return runId;
}

async function queueOrdinaryFollowup(
  fixture: GatewayFixture,
  marker = "ORDINARY_MESSAGE_B",
): Promise<void> {
  const runId = `run-${marker.toLowerCase()}`;
  const result = await fixture.diagnosticsClient.request<{ runId?: string; status?: string }>(
    "chat.send",
    {
      sessionKey: fixture.sessionKey,
      message: marker,
      deliver: false,
      queueMode: "followup",
      idempotencyKey: runId,
    },
  );
  expect(result).toMatchObject({ runId, status: "started" });
  await vi.waitFor(() => {
    expect(fixture.chatFinalRunIds).toContain(runId);
    expect(fixture.modelServer.requests).toHaveLength(1);
  }, WAIT_OPTS);
}

async function waitForRunTerminal(fixture: GatewayFixture, runId: string): Promise<void> {
  await vi.waitFor(
    () =>
      expect(fixture.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            stream: "lifecycle",
            data: expect.objectContaining({ phase: "end" }),
          }),
        ]),
      ),
    WAIT_OPTS,
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

function responseInputItems(request: ModelRequest | undefined): Array<Record<string, unknown>> {
  const input = request?.body.input;
  return Array.isArray(input)
    ? input.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function userInputs(request: ModelRequest | undefined): string[] {
  const input = request?.body.input;
  if (typeof input === "string") {
    return [input];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((item) =>
    item && typeof item === "object" && (item as { role?: unknown }).role === "user"
      ? [contentText((item as { content?: unknown }).content)]
      : [],
  );
}

function currentUserInput(request: ModelRequest | undefined): string {
  return userInputs(request).at(-1) ?? "";
}

describe("Gateway steer FIFO", () => {
  it(
    "promotes a terminal steer into the next model turn",
    async () => {
      const fixture = await createGatewayFixture("steer-terminal-fallback");
      const first = await sendHeldTurn(fixture);
      await queueSteer(fixture);

      fixture.modelServer.releaseFirst("final");

      await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(2), WAIT_OPTS);
      const currentA = currentUserInput(fixture.modelServer.requests[1]);
      expect(currentA).toContain("QUEUED_STEER_A");
      expect(currentA).not.toContain("ORDINARY_MESSAGE_B");
      await waitForRunTerminal(fixture, first.runId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "dispatches terminal A before a later ordinary B queued during the same turn",
    async () => {
      const fixture = await createGatewayFixture("steer-terminal-overtake");
      const first = await sendHeldTurn(fixture);
      await queueSteer(fixture);
      await queueOrdinaryFollowup(fixture);
      const idleBaseline = await fixture.diagnosticsClient.request<{ lastSeq?: number }>(
        "diagnostics.stability",
        { type: "session.state", limit: 1 },
      );

      fixture.modelServer.releaseFirst("final");

      await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(3), WAIT_OPTS);
      await waitForRunTerminal(fixture, first.runId);
      await vi.waitFor(async () => {
        const snapshot = await fixture.diagnosticsClient.request<{
          events?: Array<{ outcome?: string; queueDepth?: number; type?: string }>;
        }>("diagnostics.stability", {
          type: "session.state",
          sinceSeq: idleBaseline.lastSeq ?? 0,
          limit: 20,
        });
        expect(
          (snapshot.events ?? []).some(
            (event) =>
              event.type === "session.state" && event.outcome === "idle" && event.queueDepth === 0,
          ),
        ).toBe(true);
      }, WAIT_OPTS);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      const currentA = currentUserInput(fixture.modelServer.requests[1]);
      const currentB = currentUserInput(fixture.modelServer.requests[2]);
      expect(currentA).toContain("QUEUED_STEER_A");
      expect(currentA).not.toContain("ORDINARY_MESSAGE_B");
      expect(currentB).toContain("ORDINARY_MESSAGE_B");
      expect(currentB).not.toContain("QUEUED_STEER_A");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "suppresses sequential tools when a Gateway steer arrives during preflight",
    async () => {
      const fixture = await createGatewayFixture("steer-sequential-tail", {
        withSteeringTools: true,
      });
      const steeringTools = fixture.steeringTools;
      if (!steeringTools) {
        throw new Error("steering tool fixture was not configured");
      }
      const first = await sendHeldTurn(fixture);
      const steerMarker = "STEER_DURING_SEQUENTIAL_GATE";

      try {
        fixture.modelServer.releaseFirst("sequential-tools");
        await vi.waitFor(
          async () => expect(await readTrace(steeringTools.tracePath)).toEqual(["preflight-start"]),
          WAIT_OPTS,
        );
        await queueSteer(fixture, steerMarker);
      } finally {
        await writeFile(steeringTools.releasePath, "release\n", "utf8");
      }

      await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(2), WAIT_OPTS);
      await waitForRunTerminal(fixture, first.runId);
      await vi.waitFor(
        async () =>
          expect(await readTrace(steeringTools.tracePath)).toEqual([
            "preflight-start",
            "preflight-end",
          ]),
        WAIT_OPTS,
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      const nextRequest = fixture.modelServer.requests[1];
      const inputItems = responseInputItems(nextRequest);
      const gateOutputIndex = inputItems.findIndex(
        (item) => item.type === "function_call_output" && item.call_id === "call_steering_gate",
      );
      const tailOutputIndex = inputItems.findIndex(
        (item) => item.type === "function_call_output" && item.call_id === "call_steering_tail",
      );
      const steerIndex = inputItems.findIndex(
        (item) => item.role === "user" && contentText(item.content).includes(steerMarker),
      );

      expect(gateOutputIndex).toBeGreaterThanOrEqual(0);
      expect(tailOutputIndex).toBeGreaterThan(gateOutputIndex);
      expect(steerIndex).toBeGreaterThan(tailOutputIndex);
      expect(contentText(inputItems[gateOutputIndex]?.output)).toContain(
        "Skipped due to queued user message.",
      );
      expect(contentText(inputItems[tailOutputIndex]?.output)).toContain(
        "Skipped due to queued user message.",
      );
      expect(await readTrace(steeringTools.tracePath)).toEqual([
        "preflight-start",
        "preflight-end",
      ]);
      expect(fixture.modelServer.requests).toHaveLength(2);
      expect(fixture.chatErrors).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finishes a running tool, skips its sequential tail, and injects an exact UI steer once",
    async () => {
      const fixture = await createGatewayFixture("steer-running-tool-tail", {
        withSteeringTools: true,
        steeringGateMode: "execute",
      });
      const steeringTools = fixture.steeringTools;
      if (!steeringTools) {
        throw new Error("steering tool fixture was not configured");
      }
      const first = await sendHeldTurn(fixture);
      const steerMarker = "STEER_DURING_RUNNING_TOOL";

      try {
        fixture.modelServer.releaseFirst("sequential-tools");
        await vi.waitFor(async () => {
          expect(await readTrace(steeringTools.tracePath)).toEqual(["gate-execute-start"]);
          expect(fixture.modelServer.requests).toHaveLength(1);
        }, WAIT_OPTS);
        const target = await resolveUiSteerTarget(fixture, first.runId);
        const steerRunId = await queueExactUiSteer({ fixture, marker: steerMarker, target });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(fixture.chatFinalRunIds).not.toContain(steerRunId);
      } finally {
        await writeFile(steeringTools.releasePath, "release\n", "utf8");
      }

      await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(2), WAIT_OPTS);
      await waitForRunTerminal(fixture, first.runId);
      await vi.waitFor(
        async () =>
          expect(await readTrace(steeringTools.tracePath)).toEqual([
            "gate-execute-start",
            "gate-execute-end",
          ]),
        WAIT_OPTS,
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      const nextRequest = fixture.modelServer.requests[1];
      const inputItems = responseInputItems(nextRequest);
      const gateOutputIndex = inputItems.findIndex(
        (item) => item.type === "function_call_output" && item.call_id === "call_steering_gate",
      );
      const tailOutputIndex = inputItems.findIndex(
        (item) => item.type === "function_call_output" && item.call_id === "call_steering_tail",
      );
      const steerIndex = inputItems.findIndex(
        (item) => item.role === "user" && contentText(item.content).includes(steerMarker),
      );

      expect(gateOutputIndex).toBeGreaterThanOrEqual(0);
      expect(tailOutputIndex).toBeGreaterThan(gateOutputIndex);
      expect(steerIndex).toBeGreaterThan(tailOutputIndex);
      expect(contentText(inputItems[gateOutputIndex]?.output)).toContain("steering gate completed");
      expect(contentText(inputItems[gateOutputIndex]?.output)).not.toContain(
        "Skipped due to queued user message.",
      );
      expect(contentText(inputItems[tailOutputIndex]?.output)).toContain(
        "Skipped due to queued user message.",
      );
      expect(
        fixture.modelServer.requests
          .flatMap((request) => userInputs(request))
          .filter((input) => input.includes(steerMarker)),
      ).toHaveLength(1);
      expect(fixture.modelServer.requests).toHaveLength(2);
      expect(fixture.chatErrors).toEqual([]);
      expect(redactedFixtureLogs(fixture.instance)).not.toContain("active run changed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "consumes a steer at a tool control point without a fallback turn",
    async () => {
      const fixture = await createGatewayFixture("steer-tool-control-point");
      const first = await sendHeldTurn(fixture);
      await queueSteer(fixture);
      const idleBaseline = await fixture.diagnosticsClient.request<{ lastSeq?: number }>(
        "diagnostics.stability",
        { type: "session.state", limit: 1 },
      );

      fixture.modelServer.releaseFirst("tool");

      await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(2), WAIT_OPTS);
      expect(currentUserInput(fixture.modelServer.requests[1])).toContain("QUEUED_STEER_A");
      expect(JSON.stringify(fixture.modelServer.requests[1]?.body)).toContain(
        "function_call_output",
      );
      await waitForRunTerminal(fixture, first.runId);
      await vi.waitFor(async () => {
        const snapshot = await fixture.diagnosticsClient.request<{
          events?: Array<{ outcome?: string; queueDepth?: number; type?: string }>;
        }>("diagnostics.stability", {
          type: "session.state",
          sinceSeq: idleBaseline.lastSeq ?? 0,
          limit: 20,
        });
        expect(
          (snapshot.events ?? []).some(
            (event) =>
              event.type === "session.state" && event.outcome === "idle" && event.queueDepth === 0,
          ),
        ).toBe(true);
      }, WAIT_OPTS);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(fixture.modelServer.requests).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );
});

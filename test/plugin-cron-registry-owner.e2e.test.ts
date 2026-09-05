import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "../src/gateway/test-helpers.e2e.js";
import { upsertSessionEntry } from "../src/plugin-sdk/session-store-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../src/plugin-sdk/sqlite-runtime-testing.js";
import { writeOpenAiResponsesSse } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const PLUGIN_ID = "cron-registry-owner-proof";
const SCHEDULE_METHOD = `${PLUGIN_ID}.schedule`;
const CRON_EXPRESSION = "*/2 * * * * *";
const MAIN_WORKSPACE_MARKER = "MAIN_WORKSPACE_CRON_OWNER_MARKER";
const WORKER_WORKSPACE_MARKER = "WORKER_WORKSPACE_CRON_OWNER_MARKER";
const OWNER_FIRE = "CRON_OWNER_SURVIVAL_FIRE";
const PINNED_FIRE = "CRON_PINNED_LATE_FIRE";
const E2E_TIMEOUT_MS = 180_000;
const WAIT_OPTIONS = { timeout: 45_000, interval: 50 } as const;
const TEST_API_KEY = "test-token-placeholder";

type MockModelRequest = {
  body: Record<string, unknown>;
};

type MockModelServer = {
  baseUrl: string;
  requests: MockModelRequest[];
  stop: () => Promise<void>;
};

type ScheduledHandle = {
  id: string;
  pluginId: string;
  sessionKey: string;
  kind: string;
};

type ScheduleResult = {
  handle: ScheduledHandle | null;
};

type CronJobView = {
  id: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  sessionTarget: string;
  schedule: { kind: string; expr?: string; tz?: string };
  state: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    lastStatus?: string;
  };
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: string;
};

type CronListPage = {
  jobs: CronJobView[];
};

const instances: OpenClawTestInstance[] = [];
const cleanupDirs: string[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.all(modelServers.splice(0).map((server) => server.stop()));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function writeModelResponse(res: ServerResponse, sequence: number): void {
  const messageId = `msg_cron_owner_${sequence}`;
  const responseId = `resp_cron_owner_${sequence}`;
  const text = `CRON_OWNER_RESPONSE_${sequence}`;
  const message = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
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
  writeOpenAiResponsesSse(res, events);
}

async function startMockModelServer(rejectModel?: string): Promise<MockModelServer> {
  const requests: MockModelRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "cron-owner", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const body = await readJsonRequest(req);
      requests.push({ body });
      if (rejectModel && body.model === rejectModel) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Model temporarily unavailable" } }));
        return;
      }
      writeModelResponse(res, requests.length);
    })();
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

async function writeBundledSchedulerPlugin(bundledRoot: string): Promise<void> {
  const pluginDir = path.join(bundledRoot, PLUGIN_ID);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: PLUGIN_ID,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    const scheduleSessionTurn = api.session.workflow.scheduleSessionTurn;
    api.registerGatewayMethod(${JSON.stringify(SCHEDULE_METHOD)}, async ({ params, respond }) => {
      const name = typeof params?.name === "string" ? params.name : "";
      const message = typeof params?.message === "string" ? params.message : "";
      const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : "";
      const handle = await scheduleSessionTurn({
        sessionKey,
        message,
        cron: ${JSON.stringify(CRON_EXPRESSION)},
        tz: "UTC",
        deliveryMode: "none",
        tag: "registry-owner",
        name,
      });
      respond(true, { handle: handle ?? null });
    });
  },
};
`,
  );
}

function requestText(request: MockModelRequest): string {
  return JSON.stringify(request.body);
}

function requestsContaining(server: MockModelServer, marker: string): MockModelRequest[] {
  return server.requests.filter((request) => requestText(request).includes(marker));
}

async function waitForRequestCount(
  server: MockModelServer,
  marker: string,
  count: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(
      requestsContaining(server, marker).length,
      `model request marker: ${marker}`,
    ).toBeGreaterThanOrEqual(count);
  }, WAIT_OPTIONS);
}

function requireHandle(result: ScheduleResult, expected: Omit<ScheduledHandle, "id">): string {
  expect(result.handle).toMatchObject(expected);
  if (!result.handle) {
    throw new Error(`missing scheduled handle for ${expected.sessionKey}`);
  }
  expect(result.handle.id).toBeTruthy();
  return result.handle.id;
}

async function listCronJobs(client: {
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
}): Promise<CronJobView[]> {
  const page = await client.request<CronListPage>("cron.list", {
    includeDisabled: true,
    scheduleKind: "cron",
    limit: 200,
  });
  return page.jobs;
}

describe("plugin cron registry ownership e2e", () => {
  it.each(["cron", "subagent"] as const)(
    "prepares distinct selected and fallback providers for %s under per-agent defaults",
    async (route) => {
      const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-cron-selection-e2e-"));
      cleanupDirs.push(fixtureDir);
      const bundledRoot = path.join(fixtureDir, "bundled");
      const provider = "selected-cron";
      const fallbackProvider = "selected-fallback";
      const pluginIds = [provider, fallbackProvider];
      for (const pluginId of pluginIds) {
        const pluginDir = path.join(bundledRoot, pluginId);
        await mkdir(pluginDir, { recursive: true });
        await writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: pluginId,
            providers: [pluginId],
            activation: { onStartup: false, onProviders: [pluginId] },
            configSchema: { type: "object", additionalProperties: false },
          }),
        );
        await writeFile(
          path.join(pluginDir, "index.js"),
          `module.exports = {
        id: ${JSON.stringify(pluginId)},
        register(api) {
          api.registerProvider({
            id: ${JSON.stringify(pluginId)}, label: "Selected provider", auth: [],
            resolveSyntheticAuth: () => ({ apiKey: "cron-fixture", source: "fixture", mode: "api-key" }),
            transformSystemPrompt: ({ systemPrompt }) => systemPrompt + "\\n" + ${JSON.stringify(`PROVIDER_HOOK_${pluginId}`)},
          });
        },
      };\n`,
        );
      }
      const server = await startMockModelServer("unavailable");
      modelServers.push(server);
      const model = (id: string) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text"] as ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      });
      const config: OpenClawConfig = {
        plugins: {
          entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
          slots: { memory: "none" },
        },
        agents: {
          defaults: {
            workspace: path.join(fixtureDir, "workspace"),
            model: { primary: "cron-owner/default" },
            skills: [],
            ...(route === "subagent"
              ? {
                  subagents: {
                    model: {
                      primary: `${provider}/unavailable`,
                      fallbacks: [`${fallbackProvider}/available`],
                    },
                  },
                }
              : {}),
          },
          entries: { main: { model: { primary: "cron-owner/agent-default" } } },
        },
        tools: { profile: "minimal" },
        models: {
          mode: "replace",
          providers: {
            "cron-owner": {
              baseUrl: `${server.baseUrl}/v1`,
              api: "openai-responses",
              apiKey: TEST_API_KEY,
              request: { allowPrivateNetwork: true },
              models: [model("default"), model("agent-default")],
            },
            [provider]: {
              baseUrl: `${server.baseUrl}/v1`,
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [model("unavailable")],
            },
            [fallbackProvider]: {
              baseUrl: `${server.baseUrl}/v1`,
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [model("available")],
            },
          },
        },
      };
      const instance = await createOpenClawTestInstance({
        name: "cron-selected-provider",
        config,
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_SKIP_CRON: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      instances.push(instance);
      const sessionKey = "agent:main:subagent:provider-fallback";
      if (route === "subagent") {
        instance.state.applyEnv();
        await upsertSessionEntry({
          agentId: "main",
          sessionKey,
          entry: {
            sessionId: randomUUID(),
            updatedAt: Date.now(),
            providerOverride: provider,
            modelOverride: "unavailable",
            modelOverrideSource: "auto",
            modelOverrideFallbackOriginProvider: provider,
            modelOverrideFallbackOriginModel: "unavailable",
          },
        });
        closeOpenClawAgentDatabasesForTest();
      }
      await instance.startGateway();
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
      });
      let jobId: string | undefined;
      try {
        if (route === "subagent") {
          expect(
            await client.request(
              "agent",
              {
                sessionKey,
                idempotencyKey: randomUUID(),
                message: "Prove the selected provider runtime.",
                deliver: false,
                timeout: 45,
              },
              { expectFinal: true, timeoutMs: 45_000 },
            ),
          ).toMatchObject({
            status: "ok",
            result: { payloads: [{ text: expect.stringContaining("CRON_OWNER_RESPONSE_") }] },
          });
        } else {
          const job = await client.request<{ id: string }>("cron.add", {
            name: "Selected provider fallback",
            agentId: "main",
            enabled: true,
            schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
            sessionTarget: "isolated",
            wakeMode: "now",
            delivery: { mode: "none" },
            payload: {
              kind: "agentTurn",
              message: "Prove the selected provider runtime.",
              model: `${provider}/unavailable`,
              fallbacks: [`${fallbackProvider}/available`],
            },
          });
          jobId = job.id;
          const run = await client.request<{ runId: string }>("cron.run", {
            id: jobId,
            mode: "force",
          });
          let terminal: { status?: string; summary?: string; error?: string } | undefined;
          await expect
            .poll(async () => {
              const history = await client.request<{
                entries: Array<{ status?: string; summary?: string; error?: string }>;
              }>("cron.runs", { id: jobId, runId: run.runId, limit: 1 });
              terminal = history.entries[0];
              return terminal?.status;
            }, WAIT_OPTIONS)
            .toBeDefined();
          expect(terminal?.error).toBeUndefined();
          expect(terminal).toMatchObject({
            status: "ok",
            summary: expect.stringContaining("CRON_OWNER_RESPONSE_"),
          });
        }
        const models = server.requests.map(({ body }) => body.model);
        expect(models).toContain("unavailable");
        expect(models.at(-1)).toBe("available");
        expect(requestText(server.requests[0]!)).toContain(`PROVIDER_HOOK_${provider}`);
        expect(requestText(server.requests.at(-1)!)).toContain(`PROVIDER_HOOK_${fallbackProvider}`);
      } finally {
        if (jobId) {
          await client.request("cron.remove", { id: jobId });
        }
        await disconnectGatewayClient(client);
      }
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "keeps recurring startup-plugin jobs through workspace registry churn",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-cron-owner-e2e-"));
      cleanupDirs.push(fixtureDir);
      const bundledRoot = path.join(fixtureDir, "bundled");
      const mainWorkspace = path.join(fixtureDir, "workspace-main");
      const workerWorkspace = path.join(fixtureDir, "workspace-worker");
      await Promise.all([
        mkdir(mainWorkspace, { recursive: true }),
        mkdir(workerWorkspace, { recursive: true }),
        writeBundledSchedulerPlugin(bundledRoot),
      ]);
      await Promise.all([
        writeFile(path.join(mainWorkspace, "AGENTS.md"), `${MAIN_WORKSPACE_MARKER}\n`),
        writeFile(path.join(workerWorkspace, "AGENTS.md"), `${WORKER_WORKSPACE_MARKER}\n`),
      ]);

      const modelServer = await startMockModelServer();
      modelServers.push(modelServer);
      const modelRef = "cron-owner/cron-owner";
      const config = {
        plugins: {
          enabled: true,
          allow: [PLUGIN_ID],
          entries: { [PLUGIN_ID]: { enabled: true } },
          slots: { memory: "none" },
        },
        agents: {
          defaults: {
            workspace: mainWorkspace,
            model: { primary: modelRef },
            models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
            skills: [],
          },
          list: [
            {
              id: "main",
              default: true,
              workspace: mainWorkspace,
              model: { primary: modelRef },
              skills: [],
            },
            {
              id: "worker",
              workspace: workerWorkspace,
              model: { primary: modelRef },
              skills: [],
            },
          ],
        },
        tools: { profile: "minimal" },
        models: {
          mode: "replace",
          providers: {
            "cron-owner": {
              baseUrl: `${modelServer.baseUrl}/v1`,
              apiKey: TEST_API_KEY,
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [
                {
                  id: "cron-owner",
                  name: "cron-owner",
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
      } satisfies OpenClawConfig;
      const customPort = await getGatewayE2ePortBlock();
      const instance = await createOpenClawTestInstance({
        name: "plugin-cron-registry-owner",
        port: customPort,
        config,
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_SKIP_CRON: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      instances.push(instance);
      await instance.startGateway();
      expect(instance.port).toBe(customPort);

      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        requestTimeoutMs: 30_000,
      });
      const scheduledIds: string[] = [];
      try {
        const cronStatus = await client.request<{
          enabled: boolean;
          storage: string;
          sqlitePath: string;
        }>("cron.status", {});
        expect(cronStatus).toMatchObject({ enabled: true, storage: "sqlite" });
        expect(cronStatus.sqlitePath).toBe(
          path.join(instance.stateDir, "state", "openclaw.sqlite"),
        );

        const ownerResult = await client.request<ScheduleResult>(SCHEDULE_METHOD, {
          name: "owner-survival",
          message: OWNER_FIRE,
          sessionKey: "agent:main:cron-owner-survival",
        });
        const ownerId = requireHandle(ownerResult, {
          pluginId: PLUGIN_ID,
          sessionKey: "agent:main:cron-owner-survival",
          kind: "session-turn",
        });
        scheduledIds.push(ownerId);

        await client.request("chat.send", {
          sessionKey: "agent:worker:registry-churn",
          message: "ACTIVATE_WORKER_REGISTRY",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        await waitForRequestCount(modelServer, "ACTIVATE_WORKER_REGISTRY", 1);

        // The attached Gateway handler still closes over the pinned startup registry API.
        // Scheduling here proves non-active pinned registries remain live during workspace churn.
        const pinnedResult = await client.request<ScheduleResult>(SCHEDULE_METHOD, {
          name: "pinned-late",
          message: PINNED_FIRE,
          sessionKey: "agent:main:cron-pinned-late",
        });
        const pinnedId = requireHandle(pinnedResult, {
          pluginId: PLUGIN_ID,
          sessionKey: "agent:main:cron-pinned-late",
          kind: "session-turn",
        });
        scheduledIds.push(pinnedId);

        const ownerWorkerActiveBaseline = requestsContaining(modelServer, OWNER_FIRE).length;
        const pinnedWorkerActiveBaseline = requestsContaining(modelServer, PINNED_FIRE).length;
        await Promise.all([
          waitForRequestCount(modelServer, OWNER_FIRE, ownerWorkerActiveBaseline + 1),
          waitForRequestCount(modelServer, PINNED_FIRE, pinnedWorkerActiveBaseline + 1),
        ]);
        for (const request of [
          ...requestsContaining(modelServer, OWNER_FIRE).slice(ownerWorkerActiveBaseline),
          ...requestsContaining(modelServer, PINNED_FIRE).slice(pinnedWorkerActiveBaseline),
        ]) {
          expect(requestText(request)).toContain(MAIN_WORKSPACE_MARKER);
          expect(requestText(request)).not.toContain(WORKER_WORKSPACE_MARKER);
        }

        const mainReactivationBaseline = requestsContaining(
          modelServer,
          "REACTIVATE_MAIN_REGISTRY",
        ).length;
        await client.request("chat.send", {
          sessionKey: "agent:main:registry-churn",
          message: "REACTIVATE_MAIN_REGISTRY",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        await waitForRequestCount(
          modelServer,
          "REACTIVATE_MAIN_REGISTRY",
          mainReactivationBaseline + 1,
        );

        const expectedIds = [ownerId, pinnedId].toSorted();
        const afterChurn = (await listCronJobs(client))
          .filter((job) => expectedIds.includes(job.id))
          .toSorted((a, b) => a.id.localeCompare(b.id));
        expect(afterChurn.map((job) => job.id)).toEqual(expectedIds);
        expect(afterChurn).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: ownerId,
              enabled: true,
              deleteAfterRun: false,
              sessionTarget: "session:agent:main:cron-owner-survival",
              schedule: { kind: "cron", expr: CRON_EXPRESSION, tz: "UTC" },
            }),
            expect.objectContaining({
              id: pinnedId,
              enabled: true,
              deleteAfterRun: false,
              sessionTarget: "session:agent:main:cron-pinned-late",
              schedule: { kind: "cron", expr: CRON_EXPRESSION, tz: "UTC" },
            }),
          ]),
        );
        const nextRunAtChurn = new Map(
          afterChurn.map((job) => [job.id, job.nextRunAtMs ?? job.state.nextRunAtMs]),
        );
        expect([...nextRunAtChurn.values()]).toEqual([expect.any(Number), expect.any(Number)]);

        const ownerBaseline = requestsContaining(modelServer, OWNER_FIRE).length;
        const pinnedBaseline = requestsContaining(modelServer, PINNED_FIRE).length;
        await Promise.all([
          waitForRequestCount(modelServer, OWNER_FIRE, ownerBaseline + 2),
          waitForRequestCount(modelServer, PINNED_FIRE, pinnedBaseline + 2),
        ]);

        for (const request of [
          ...requestsContaining(modelServer, OWNER_FIRE).slice(ownerBaseline),
          ...requestsContaining(modelServer, PINNED_FIRE).slice(pinnedBaseline),
        ]) {
          expect(requestText(request)).toContain(MAIN_WORKSPACE_MARKER);
          expect(requestText(request)).not.toContain(WORKER_WORKSPACE_MARKER);
        }

        const afterRecurringRuns = (await listCronJobs(client)).filter((job) =>
          expectedIds.includes(job.id),
        );
        expect(afterRecurringRuns.map((job) => job.id).toSorted()).toEqual(expectedIds);
        for (const job of afterRecurringRuns) {
          expect(job.enabled).toBe(true);
          expect(job.deleteAfterRun).toBe(false);
          expect(job.lastRunStatus ?? job.state.lastRunStatus ?? job.state.lastStatus).toBe("ok");
          const lastRunAtMs = job.lastRunAtMs ?? job.state.lastRunAtMs;
          const nextRunAtMs = job.nextRunAtMs ?? job.state.nextRunAtMs;
          expect(lastRunAtMs).toBeTypeOf("number");
          expect(nextRunAtMs).toBeTypeOf("number");
          expect(nextRunAtMs as number).toBeGreaterThan(lastRunAtMs as number);
          expect(nextRunAtMs as number).toBeGreaterThan(nextRunAtChurn.get(job.id) as number);
        }
      } finally {
        await Promise.all(
          scheduledIds.map((id) =>
            client.request("cron.remove", { id }).catch(() => ({ removed: false })),
          ),
        );
        await disconnectGatewayClient(client).catch(() => undefined);
      }
    },
  );
});

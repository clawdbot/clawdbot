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
  getFreeGatewayPort,
} from "../src/gateway/test-helpers.e2e.js";
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
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

async function startMockModelServer(): Promise<MockModelServer> {
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
      requests.push({ body: await readJsonRequest(req) });
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
    expect(requestsContaining(server, marker).length).toBeGreaterThanOrEqual(count);
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
              ["api" + "Key"]: TEST_API_KEY,
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
      const customPort = await getFreeGatewayPort();
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
        ["to" + "ken"]: instance.gatewayToken,
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

import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const API_KEY = "clawrouter-e2e-secret";
const MODEL_ID = "openai/gpt-5.5";
const MODEL_REF = `clawrouter/${MODEL_ID}`;
const SUCCESS_MARKER = "CLAWROUTER_E2E_OK";

type CapturedRequest = {
  method: string;
  path: string;
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
};

type FakeClawRouter = {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

const instances: OpenClawTestInstance[] = [];
const routers: FakeClawRouter[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(routers.splice(0).map((router) => router.close()));
});

describe("ClawRouter managed gateway contract", () => {
  it("boots from a SecretRef, reports truthful readiness, and routes an attributed agent turn", async () => {
    const router = await startFakeClawRouter();
    routers.push(router);
    const instance = await createOpenClawTestInstance({
      name: "clawrouter-managed-gateway",
      env: {
        CLAWROUTER_API_KEY: API_KEY,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    instances.push(instance);

    const patchPath = await instance.state.writeText(
      "clawrouter.patch.json5",
      JSON.stringify(
        {
          plugins: {
            allow: ["clawrouter"],
            entries: { clawrouter: { enabled: true } },
          },
          models: {
            providers: {
              clawrouter: {
                baseUrl: router.baseUrl,
                apiKey: { source: "env", provider: "default", id: "CLAWROUTER_API_KEY" },
                headers: { "X-ClawRouter-Project-Id": "fakeco-e2e" },
              },
            },
          },
          agents: { defaults: { model: { primary: MODEL_REF } } },
        },
        null,
        2,
      ),
    );
    const dryRun = await instance.cli(
      ["config", "patch", "--file", patchPath, "--dry-run", "--json"],
      { timeoutMs: 120_000 },
    );
    expect(dryRun.code, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toMatch(/"ok"\s*:\s*true/u);

    const bootstrap = await instance.cli(["config", "patch", "--file", patchPath], {
      timeoutMs: 120_000,
    });
    expect(bootstrap.code, bootstrap.stderr).toBe(0);

    const configText = await fs.readFile(instance.configPath, "utf8");
    const config = JSON.parse(configText) as {
      agents?: { defaults?: { model?: { primary?: string } } };
      models?: {
        providers?: Record<
          string,
          {
            apiKey?: unknown;
            baseUrl?: string;
            headers?: Record<string, string>;
          }
        >;
      };
      plugins?: { allow?: string[]; entries?: Record<string, { enabled?: boolean }> };
    };
    expect(config.models?.providers?.clawrouter).toMatchObject({
      apiKey: { source: "env", provider: "default", id: "CLAWROUTER_API_KEY" },
      baseUrl: router.baseUrl,
      headers: { "X-ClawRouter-Project-Id": "fakeco-e2e" },
    });
    expect(config.agents?.defaults?.model?.primary).toBe(MODEL_REF);
    expect(config.plugins?.allow).toContain("clawrouter");
    expect(config.plugins?.entries?.clawrouter?.enabled).toBe(true);
    expect(configText).not.toContain(API_KEY);

    const routerHealth = await fetch(`${router.baseUrl}/v1/health`);
    expect(routerHealth.status).toBe(200);
    await expect(routerHealth.json()).resolves.toMatchObject({
      ok: true,
      environment: "fakeco",
      observability: {
        mode: "metadata_only",
        requestContentRetentionDefault: false,
      },
    });
    const rejectedCatalog = await fetch(`${router.baseUrl}/v1/catalog`, {
      headers: { Authorization: "Bearer wrong-secret" },
    });
    expect(rejectedCatalog.status).toBe(401);

    await instance.startGateway();
    const gatewayReadiness = await waitForGatewayReadiness(instance);
    expect(gatewayReadiness).toMatchObject({ ready: true, failing: [] });

    const catalog = await instance.cli(
      ["models", "list", "--all", "--provider", "clawrouter", "--json"],
      { timeoutMs: 120_000 },
    );
    expect(catalog.code, catalog.stderr).toBe(0);
    expect(catalog.stdout).toContain(MODEL_REF);

    const probe = await instance.cli(
      [
        "models",
        "status",
        "--probe",
        "--probe-provider",
        "clawrouter",
        "--probe-max-tokens",
        "8",
        "--json",
      ],
      { timeoutMs: 120_000 },
    );
    expect(probe.code, probe.stderr).toBe(0);
    expect(probe.stdout).toMatch(/"provider"\s*:\s*"clawrouter"/u);
    expect(probe.stdout).toMatch(/"status"\s*:\s*"ok"/u);

    const agent = await instance.cli(
      [
        "agent",
        "--agent",
        "main",
        "--model",
        MODEL_REF,
        "--message",
        `Reply exactly: ${SUCCESS_MARKER}`,
        "--json",
      ],
      { timeoutMs: 120_000 },
    );
    expect(agent.code, agent.stderr).toBe(0);
    expect(agent.stdout).toContain(SUCCESS_MARKER);

    const inferenceRequests = router.requests.filter(
      (request) => request.method === "POST" && request.path === "/v1/responses",
    );
    expect(inferenceRequests.length).toBeGreaterThanOrEqual(2);
    expect(inferenceRequests.at(-1)).toMatchObject({
      authorization: `Bearer ${API_KEY}`,
      body: { model: MODEL_ID, stream: true },
      headers: {
        "x-clawrouter-agent-id": "main",
        "x-clawrouter-client": "openclaw",
        "x-clawrouter-project-id": "fakeco-e2e",
      },
    });
    const sessionId = inferenceRequests.at(-1)?.headers["x-clawrouter-session-id"];
    const requestId = inferenceRequests.at(-1)?.headers["x-request-id"];
    expect(JSON.stringify(inferenceRequests.at(-1)?.body)).toContain(SUCCESS_MARKER);
    expect(typeof sessionId).toBe("string");
    expect(String(sessionId).length).toBeGreaterThan(0);
    expect(String(sessionId).length).toBeLessThanOrEqual(256);
    expect(typeof requestId).toBe("string");
    expect(String(requestId)).toMatch(/:model:\d+$/u);
    expect(String(requestId).length).toBeLessThanOrEqual(128);

    expect(instance.logs()).toContain(
      `[model-fetch] start provider=clawrouter api=openai-responses model=${MODEL_ID} method=POST url=${router.baseUrl}/v1/responses`,
    );
    expect(instance.logs()).toContain(
      `[model-fetch] response provider=clawrouter api=openai-responses model=${MODEL_ID} status=200`,
    );
    expect(
      [
        bootstrap.stdout,
        bootstrap.stderr,
        dryRun.stdout,
        dryRun.stderr,
        catalog.stdout,
        catalog.stderr,
        probe.stdout,
        probe.stderr,
        agent.stdout,
        agent.stderr,
        instance.logs(),
      ].join("\n"),
    ).not.toContain(API_KEY);
  }, 240_000);
});

async function waitForGatewayReadiness(
  instance: OpenClawTestInstance,
): Promise<{ ready: boolean; failing: string[] }> {
  const url = `http://127.0.0.1:${instance.port}/readyz`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return (await response.json()) as { ready: boolean; failing: string[] };
      }
    } catch {
      // The listener can open before startup readiness settles.
    }
    await delay(50);
  }
  throw new Error(`gateway did not become ready: ${instance.logs()}`);
}

async function startFakeClawRouter(): Promise<FakeClawRouter> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    void handleClawRouterRequest(req, res, requests).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("fake ClawRouter did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleClawRouterRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requests: CapturedRequest[],
): Promise<void> {
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const bodyText = await readRequestBody(req);
  const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : undefined;
  const authorization = req.headers.authorization;
  requests.push({ method, path, authorization, headers: { ...req.headers }, body });

  if (method === "GET" && path === "/v1/health") {
    writeJson(res, 200, {
      ok: true,
      environment: "fakeco",
      observability: {
        mode: "metadata_only",
        requestContentRetentionDefault: false,
      },
    });
    return;
  }

  if (authorization !== `Bearer ${API_KEY}`) {
    writeJson(res, 401, { error: { message: "unauthorized" } });
    return;
  }

  if (method === "GET" && path === "/v1/catalog") {
    writeJson(res, 200, {
      providers: [
        {
          id: "openai",
          displayName: "OpenAI",
          openaiCompatible: true,
          nativeBaseUrl: "/v1/native/openai",
          routes: [],
          models: [
            {
              id: MODEL_ID,
              upstream: "gpt-5.5",
              capabilities: ["llm.responses"],
            },
          ],
        },
      ],
    });
    return;
  }

  if (method === "GET" && path === "/v1/usage") {
    writeJson(res, 200, {
      budget: { configured: false, ledger: "unmetered" },
      usage: { summary: { requestCount: 0, totalTokens: 0, actualCostMicros: 0 } },
    });
    return;
  }

  if (method === "POST" && path === "/v1/responses") {
    writeResponsesStream(res, resolveResponseText(body));
    return;
  }

  writeJson(res, 404, { error: { message: `unexpected ${method} ${path}` } });
}

function resolveResponseText(body: Record<string, unknown> | undefined): string {
  const matches = JSON.stringify(body ?? {}).match(/CLAWROUTER_[A-Z0-9_]+/gu);
  return matches?.at(-1) ?? "CLAWROUTER_PROBE_OK";
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeResponsesStream(res: ServerResponse, text: string): void {
  const itemId = "msg_clawrouter_e2e";
  const events = [
    {
      type: "response.output_item.added",
      item: { type: "message", id: itemId, role: "assistant", content: [], status: "in_progress" },
    },
    {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: itemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_clawrouter_e2e",
        status: "completed",
        output: [
          {
            type: "message",
            id: itemId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
  res.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream",
    "x-clawrouter-content-retention": "off",
    "x-clawrouter-upstream-provider": "openai",
    "x-request-id": "clawrouter-e2e-request",
  });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

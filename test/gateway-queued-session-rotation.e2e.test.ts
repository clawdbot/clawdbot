import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createDeferred } from "../src/test-utils/deferred.js";
import { GatewayChatClient } from "../src/tui/gateway-chat.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

type MockModelRequest = {
  body: Record<string, unknown>;
};

type MockModelServer = {
  baseUrl: string;
  requests: MockModelRequest[];
  releaseHeldResponse: () => void;
  stop: () => Promise<void>;
};

const TEST_TIMEOUT_MS = 150_000;
const WAIT_OPTS = { timeout: 30_000, interval: 20 } as const;

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

function writeResponse(res: ServerResponse, text: string): void {
  const messageId = "msg_queued_rotation";
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
        id: "resp_queued_rotation",
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
  const heldResponse = createDeferred();
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "queued-rotation", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      requests.push({ body: await readJsonRequest(req) });
      if (requests.length === 1) {
        await heldResponse.promise;
        if (res.destroyed) {
          return;
        }
      }
      writeResponse(res, requests.length === 1 ? "FIRST_TURN_COMPLETE" : "RESET_TURN_COMPLETE");
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
    releaseHeldResponse: () => heldResponse.resolve(),
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      heldResponse.resolve();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

async function writeTurnTracerPlugin(pluginDir: string, tracePath: string): Promise<void> {
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "queued-rotation-tracer",
      name: "Queued Rotation Tracer",
      description: "Records agent-turn preparation for the queued session rotation E2E test.",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await writeFile(
    path.join(pluginDir, "index.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      "export default {",
      '  id: "queued-rotation-tracer",',
      '  name: "Queued Rotation Tracer",',
      "  register(api) {",
      '    api.on("agent_turn_prepare", () => {',
      `      appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ prepared: true }) + "\\n");`,
      "      return {};",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

async function readTraceCount(tracePath: string): Promise<number> {
  try {
    return (await readFile(tracePath, "utf8")).split("\n").filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

describe("Gateway queued session rotation", () => {
  it(
    "runs a replacement turn after /new cancels an active turn",
    async () => {
      const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-queued-rotation-"));
      cleanupDirs.push(fixtureDir);
      const pluginDir = path.join(fixtureDir, "plugin");
      const tracePath = path.join(fixtureDir, "turns.ndjson");
      await mkdir(pluginDir, { recursive: true });
      await writeTurnTracerPlugin(pluginDir, tracePath);

      const modelServer = await startMockModelServer();
      modelServers.push(modelServer);
      const modelRef = "queued-rotation/queued-rotation";
      const config = {
        plugins: {
          enabled: true,
          allow: ["queued-rotation-tracer"],
          load: { paths: [pluginDir] },
          entries: { "queued-rotation-tracer": { enabled: true } },
          slots: { memory: "none" },
        },
        agents: {
          defaults: {
            workspace: path.join(fixtureDir, "workspace"),
            model: { primary: modelRef },
            models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
            skills: [],
            skipBootstrap: true,
          },
          list: [{ id: "main", default: true, model: { primary: modelRef }, skills: [] }],
        },
        tools: { profile: "minimal" },
        models: {
          mode: "replace",
          providers: {
            "queued-rotation": {
              baseUrl: `${modelServer.baseUrl}/v1`,
              apiKey: "secret-token",
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [
                {
                  id: "queued-rotation",
                  name: "queued-rotation",
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
        messages: { queue: { mode: "followup" } },
      } satisfies OpenClawConfig;
      const instance = await createOpenClawTestInstance({
        name: "queued-session-rotation",
        gatewayToken: "secret-token",
        config,
        env: { OPENCLAW_SKIP_PROVIDERS: undefined },
      });
      instances.push(instance);
      await instance.startGateway();

      const client = new GatewayChatClient({
        url: instance.url,
        token: "secret-token",
        allowInsecureLocalOperatorUi: false,
      });
      client.start();
      await client.waitForReady();
      const sessionKey = "agent:main:queued-rotation-e2e";
      try {
        const first = await client.sendChat({
          sessionKey,
          message: "OPENCLAW_E2E_HELD_TURN",
          runId: "queued-rotation-held",
        });
        expect(first.status).toBe("started");
        await vi.waitFor(async () => {
          expect(modelServer.requests).toHaveLength(1);
          expect(await readTraceCount(tracePath)).toBe(1);
        }, WAIT_OPTS);

        const replacement = await client.sendChat({
          sessionKey,
          message: "/new OPENCLAW_E2E_AFTER_RESET",
          runId: "queued-rotation-reset",
        });
        expect(replacement.status).toBe("started");

        // The accepted reset turn must keep its lifecycle through cancellation and
        // rotation; losing it here leaves the turn before both hook and model entry.
        await vi.waitFor(async () => {
          expect(modelServer.requests).toHaveLength(2);
          expect(await readTraceCount(tracePath)).toBe(2);
        }, WAIT_OPTS);
        expect(JSON.stringify(modelServer.requests[0]?.body)).toContain("OPENCLAW_E2E_HELD_TURN");
        expect(JSON.stringify(modelServer.requests[1]?.body)).toContain("OPENCLAW_E2E_AFTER_RESET");
      } finally {
        await client.abortChat({ sessionKey }).catch(() => undefined);
        client.stop();
        modelServer.releaseHeldResponse();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// QA Lab product proof for the Gateway's public HTTP API boundaries.
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../../src/config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../../../src/config/sessions.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  startTestGatewayServer,
  testState,
} from "../../../../src/gateway/test-helpers.js";
import { peekSystemEventEntries } from "../../../../src/infra/system-events.js";

installGatewayTestHooks();

const GATEWAY_TOKEN = "qa-gateway-token";
const HOOK_TOKEN = "qa-hook-token";
const JSON_HEADERS = {
  authorization: `Bearer ${GATEWAY_TOKEN}`,
  "content-type": "application/json",
};

type JsonRecord = Record<string, unknown>;

async function readJsonBody(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
}

async function startEmbeddingFixture() {
  const requests: JsonRecord[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readJsonBody(req);
      requests.push({ method: req.method, url: req.url, body });
      const input = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: input.map((_text, index) => ({
            object: "embedding",
            embedding: [index + 0.25, index + 0.5],
            index,
          })),
          model: body.model,
        }),
      );
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function fetchJson(port: number, pathname: string, init?: RequestInit) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  return { response, body: (await response.json()) as JsonRecord };
}

describe("Gateway HTTP API product proof", () => {
  it("serves OpenAI-compatible, tool invocation, and hook ingress APIs over TCP", async () => {
    const embeddingFixture = await startEmbeddingFixture();
    let gateway: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;

    try {
      const configPath = createConfigIO().configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            memory: {
              search: {
                provider: "openai-compatible",
                model: "qa-embedding",
                documentInputType: "document",
                remote: { baseUrl: embeddingFixture.baseUrl },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      resetConfigRuntimeState();

      testState.agentsConfig = {
        entries: {
          main: { default: true, tools: { allow: ["agents_list"] } },
          beta: {},
        },
      };
      testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
      agentCommand
        .mockResolvedValueOnce({ payloads: [{ text: "qa chat response" }] } as never)
        .mockResolvedValueOnce({ payloads: [{ text: "qa responses response" }] } as never);

      const port = await getFreePort();
      gateway = await startTestGatewayServer(port, {
        host: "127.0.0.1",
        auth: { mode: "token", token: GATEWAY_TOKEN },
        controlUiEnabled: false,
        openAiChatCompletionsEnabled: true,
        openResponsesEnabled: true,
      });

      const models = await fetchJson(port, "/v1/models", { headers: JSON_HEADERS });
      expect(models.response.status).toBe(200);
      expect(models.body.object).toBe("list");
      expect((models.body.data as Array<{ id?: string }>).map((model) => model.id)).toEqual(
        expect.arrayContaining(["openclaw/main", "openclaw/beta"]),
      );

      const chat = await fetchJson(port, "/v1/chat/completions", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          model: "openclaw/main",
          stream: false,
          messages: [{ role: "user", content: "qa chat request" }],
        }),
      });
      expect(chat.response.status).toBe(200);
      expect(
        (
          chat.body.choices as Array<{
            message?: { content?: string };
          }>
        )[0]?.message?.content,
      ).toBe("qa chat response");

      const responses = await fetchJson(port, "/v1/responses", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          model: "openclaw/main",
          stream: false,
          input: "qa responses request",
        }),
      });
      expect(responses.response.status).toBe(200);
      expect(responses.body.status).toBe("completed");
      const output = responses.body.output as Array<{
        content?: Array<{ type?: string; text?: string }>;
      }>;
      expect(output[0]?.content?.[0]).toEqual({
        type: "output_text",
        text: "qa responses response",
      });
      expect(agentCommand).toHaveBeenCalledTimes(2);
      expect(agentCommand.mock.calls.map((call) => call[0])).toEqual([
        expect.objectContaining({
          message: "qa chat request",
          sessionKey: expect.stringMatching(/^agent:main:openai:/),
        }),
        expect.objectContaining({
          message: "qa responses request",
          sessionKey: expect.stringMatching(/^agent:main:openresponses:/),
        }),
      ]);

      const embeddings = await fetchJson(port, "/v1/embeddings", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          model: "openclaw/main",
          input: ["alpha", "beta"],
        }),
      });
      expect(embeddings.response.status).toBe(200);
      expect(embeddings.body.data).toEqual([
        expect.objectContaining({ index: 0, embedding: [0.25, 0.5] }),
        expect.objectContaining({ index: 1, embedding: [1.25, 1.5] }),
      ]);
      expect(embeddingFixture.requests).toEqual([
        expect.objectContaining({
          method: "POST",
          url: "/v1/embeddings",
          body: expect.objectContaining({
            model: "qa-embedding",
            input: ["alpha", "beta"],
            input_type: "document",
          }),
        }),
      ]);

      const tool = await fetchJson(port, "/tools/invoke", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tool: "agents_list",
          action: "json",
          args: {},
          sessionKey: "main",
        }),
      });
      expect(tool.response.status).toBe(200);
      expect(tool.body.ok).toBe(true);
      expect(tool.body.result).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            requester: "main",
            allowAny: false,
            agents: [expect.objectContaining({ id: "main", configured: true })],
          }),
        }),
      );

      const malformedTool = await fetchJson(port, "/tools/invoke", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
      expect(malformedTool.response.status).toBe(400);
      expect(malformedTool.body).toEqual({
        ok: false,
        error: {
          type: "invalid_request",
          message: "tools.invoke requires name",
        },
      });

      const mainSessionKey = resolveMainSessionKeyFromConfig();
      const unauthenticatedWake = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "must not queue", mode: "next-heartbeat" }),
      });
      expect(unauthenticatedWake.status).toBe(401);
      expect(await unauthenticatedWake.text()).toBe("Unauthorized");
      expect(peekSystemEventEntries(mainSessionKey)).toHaveLength(0);

      const authenticatedWake = await fetchJson(port, "/hooks/wake", {
        method: "POST",
        headers: {
          authorization: `Bearer ${HOOK_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "Gateway HTTP QA wake", mode: "next-heartbeat" }),
      });
      expect(authenticatedWake.response.status).toBe(200);
      expect(authenticatedWake.body).toEqual({ ok: true, mode: "next-heartbeat" });
      expect(peekSystemEventEntries(mainSessionKey).map((event) => event.text)).toEqual([
        "Gateway HTTP QA wake",
      ]);
    } finally {
      await gateway?.close({ reason: "Gateway HTTP API QA proof complete" });
      await embeddingFixture.close();
    }
  }, 60_000);
});

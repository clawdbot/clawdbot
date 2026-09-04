import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { GatewayClient } from "../gateway/client.js";

const ABORT_CAUSE = "session_status tool validation failed: invalid arguments";

function writeToolCall(response: ServerResponse): void {
  const call = {
    type: "function_call",
    id: "fc_abort_cause",
    call_id: "call_abort_cause",
    name: "session_status",
    arguments: JSON.stringify({ changesSince: "not-a-number" }),
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...call, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: call.id,
      output_index: 0,
      delta: call.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item: call },
    {
      type: "response.completed",
      response: {
        id: "resp_abort_cause",
        status: "completed",
        output: [call],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      },
    },
  ];
  writeOpenAiResponsesSse(response, events);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock provider did not bind a loopback port");
  }
  return address.port;
}

async function connectOperator(instance: OpenClawTestInstance): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const client = new GatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      clientName: "cli",
      clientDisplayName: "ACP abort-cause test operator",
      clientVersion: "test",
      mode: "cli",
      role: "operator",
      scopes: ["operator.write", "operator.admin"],
      deviceIdentity: null,
      env: instance.env,
      sharedStateMode: "read-only",
      onHelloOk: () => {
        settled = true;
        resolve(client);
      },
      onConnectError: reject,
      onClose: (code, reason) => {
        if (!settled) {
          reject(new Error(`operator connection closed: ${code} ${reason}`));
        }
      },
    });
    client.start();
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.stdin.end();
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
    }),
    delay(2_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

describe("openclaw acp abort causes", () => {
  it(
    "shows the carried tool-validation cause before cancelled settlement",
    { timeout: 120_000 },
    async () => {
      let instance: OpenClawTestInstance | undefined;
      let operator: GatewayClient | undefined;
      let acpProcess: ChildProcessWithoutNullStreams | undefined;
      const stalledResponses = new Set<ServerResponse>();
      let providerRequestCount = 0;
      let failedToolUpdate = false;
      const provider = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          providerRequestCount += 1;
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const tools = isRecord(body) && Array.isArray(body.tools) ? body.tools : [];
          if (!tools.some((tool) => isRecord(tool) && tool.name === "session_status")) {
            throw new Error("session_status tool missing from provider request");
          }
          if (providerRequestCount > 1) {
            stalledResponses.add(response);
            request.once("close", () => stalledResponses.delete(response));
            return;
          }
          writeToolCall(response);
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      });

      try {
        const providerPort = await listen(provider);
        instance = await createOpenClawTestInstance({
          name: "acp-abort-cause",
          config: {
            agents: {
              defaults: {
                workspace: process.cwd(),
                skipBootstrap: true,
                model: { primary: "mock-openai/gpt-acp-abort-cause" },
                models: {
                  "mock-openai/gpt-acp-abort-cause": {
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                },
              },
            },
            models: {
              mode: "replace",
              providers: {
                "mock-openai": {
                  baseUrl: `http://127.0.0.1:${providerPort}/v1`,
                  apiKey: "test",
                  api: "openai-responses",
                  models: [
                    {
                      id: "gpt-acp-abort-cause",
                      name: "gpt-acp-abort-cause",
                      api: "openai-responses",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 128_000,
                      maxTokens: 4096,
                    },
                  ],
                },
              },
            },
            plugins: { slots: { memory: "none" } },
          },
          env: {
            OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        });
        await instance.startGateway();
        operator = await connectOperator(instance);

        const entrypoint = await instance.entrypoint();
        acpProcess = spawn(
          process.execPath,
          [...entrypoint, "acp", "--url", instance.url, "--token", instance.gatewayToken],
          { cwd: process.cwd(), env: instance.env, stdio: ["pipe", "pipe", "pipe"] },
        );
        const timeline: string[] = [];
        // SAFETY: Node and DOM ReadableStream types describe the same runtime object here.
        const output = Readable.toWeb(acpProcess.stdout) as Parameters<typeof ndJsonStream>[1];
        const stream = ndJsonStream(Writable.toWeb(acpProcess.stdin), output);
        const client = new ClientSideConnection(
          () => ({
            sessionUpdate: async (notification: SessionNotification) => {
              const update = notification.update;
              if (
                update.sessionUpdate === "agent_message_chunk" &&
                update.content.type === "text"
              ) {
                timeline.push(update.content.text);
              }
              if (update.sessionUpdate === "tool_call_update" && update.status === "failed") {
                failedToolUpdate = true;
              }
            },
            requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
          }),
          stream,
        );
        await client.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          clientInfo: { name: "openclaw-acp-abort-cause-test", version: "1.0.0" },
        });
        const sessionKey = `agent:main:acp-abort-cause-${process.pid}`;
        const session = await client.newSession({
          cwd: process.cwd(),
          mcpServers: [],
          _meta: { sessionKey },
        });
        const prompt = client.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Call session_status now." }],
        });

        await expect
          .poll(() => ({ failedToolUpdate, providerRequestCount }), {
            timeout: 30_000,
            interval: 25,
          })
          .toEqual({ failedToolUpdate: true, providerRequestCount: 2 });
        await expect(operator.request("chat.abort", { sessionKey })).resolves.toMatchObject({
          aborted: true,
        });
        const result = await prompt;
        timeline.push(result.stopReason);

        expect(timeline).toContain(`[OpenClaw interruption] ${ABORT_CAUSE}`);
        expect(timeline.at(-1)).toBe("cancelled");
      } finally {
        for (const response of stalledResponses) {
          response.destroy();
        }
        await stopChild(acpProcess);
        await operator?.stopAndWait({ timeoutMs: 1_000 }).catch(() => operator?.stop());
        await instance?.cleanup();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => {
          provider.close(() => resolve());
        });
      }
    },
  );
});

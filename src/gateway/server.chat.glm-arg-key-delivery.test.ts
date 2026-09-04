import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const STREAM_DELTAS = [
  "Visible\n<tool_call>exec ",
  "<arg_key>command</arg_key><arg_value>echo redacted</arg_value></tool_call>",
  "\nDone.",
] as const;
const TERMINAL_TEXT = STREAM_DELTAS.join("");
const DELIVERED_TEXT = "Visible\n\nDone.";
const RUN_ID = "glm-arg-key-delivery";
const SESSION_KEY = "agent:main:glm-arg-key-delivery";
const TOKEN = "glm-arg-key-delivery-token";

function writeSse(response: import("node:http").ServerResponse, event: unknown) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function chatMessageText(payload: unknown): string {
  const message = (payload as { message?: unknown } | undefined)?.message;
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("");
}

it(
  "strips streamed GLM <tool_call>exec <arg_key> shadow XML from chat.final",
  { timeout: 90_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "glm-arg-key-delivery",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    const terminal = createDeferred<unknown>();
    const providerServer = createServer((request, response) => {
      void (async () => {
        for await (const chunk of request) {
          void chunk;
        }
        const message = {
          type: "message",
          id: "glm-msg",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: TERMINAL_TEXT, annotations: [] }],
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        writeSse(response, {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        });
        for (const delta of STREAM_DELTAS) {
          writeSse(response, {
            type: "response.output_text.delta",
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta,
          });
          await delay(15);
        }
        writeSse(response, {
          type: "response.output_text.done",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          text: TERMINAL_TEXT,
        });
        writeSse(response, { type: "response.output_item.done", output_index: 0, item: message });
        writeSse(response, {
          type: "response.completed",
          response: {
            id: "glm-response",
            status: "completed",
            output: [message],
            usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 },
          },
        });
        response.end("data: [DONE]\n\n");
      })().catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("mock provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "glm-proof",
      );
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
          },
        },
        plugins: { slots: { memory: "none" } },
        tools: { profile: "minimal" },
        gateway: { auth: { mode: "token", token: TOKEN } },
      } satisfies OpenClawConfig;
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: TOKEN,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => {
          const payload = event.payload as { runId?: string; state?: string } | undefined;
          if (event.event === "chat" && payload?.runId === RUN_ID && payload.state === "final") {
            terminal.resolve(event.payload);
          }
        },
      });
      await gateway.client.request("sessions.messages.subscribe", { key: SESSION_KEY });
      await gateway.client.request("chat.send", {
        sessionKey: SESSION_KEY,
        message: "Reply with the scripted GLM shadow text.",
        idempotencyKey: RUN_ID,
      });
      const delivered = chatMessageText(await terminal.promise);
      expect(delivered).toBe(DELIVERED_TEXT);
      expect(delivered).not.toMatch(/<arg_key\b|<tool_call>exec/i);
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        await gateway.server.close({ reason: "glm arg_key delivery proof cleanup" });
      }
      await new Promise<void>((resolve) => {
        providerServer.close(() => resolve());
      });
      await state.cleanup();
    }
  },
);

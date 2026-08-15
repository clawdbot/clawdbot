// Real-setup proof for #124084: a model that nests its tool_call selector one
// level too deep (`{args:{toolId,args}}`) must still reach the target tool
// through a real ephemeral Gateway + real agent loop + real (loopback) HTTP
// model transport, not just a synthetic StreamFn. This exercises the exact
// production `prepareToolSearchDispatcherArguments` wiring on the real
// `tool_call` tool definition (src/agents/tool-search.ts) via
// `prepareToolCallArguments` in the real agent loop
// (packages/agent-core/src/agent-loop.ts), the same call chain a live model
// provider drives in production.
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

function writeSse(res: ServerResponse, events: Record<string, unknown>[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

// Turn 1: the model calls tool_call directly with a double-wrapped selector
// nesting `toolId` one level under `args` -- the exact #124084 shape a
// smaller/weaker model produces when it conflates the dispatcher envelope
// with the target tool's own argument shape.
function writeDoubleWrappedToolCallResponse(res: ServerResponse): void {
  const item = {
    type: "function_call",
    id: "fc_proof_tool_call",
    call_id: "call_proof_tool_call",
    name: "tool_call",
    arguments: JSON.stringify({ args: { toolId: "session_status", args: {} } }),
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
        id: "resp_proof_tool_call",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

// Turn 2: final text completion after the recovered tool_call round-trips.
function writeFinalTextResponse(res: ServerResponse): void {
  const message = {
    type: "message",
    id: "msg_proof_final",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "DOUBLE_WRAPPED_SELECTOR_RECOVERED", annotations: [] }],
  };
  writeSse(res, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp_proof_final",
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

describe("#124084 real gateway proof: double-wrapped tool_call selector", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "recovers a nested toolId alias through a real Gateway, agent loop, and HTTP model transport",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const requests: Record<string, unknown>[] = [];

      try {
        tempHome = await fs.mkdtemp(
          path.join(os.tmpdir(), "openclaw-124084-double-wrapped-proof-"),
        );
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "openclaw-124084-proof-token",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

        providerServer = createServer((req, res) => {
          void (async () => {
            requests.push(await readJsonRequest(req));
            if (requests.length === 1) {
              writeDoubleWrappedToolCallResponse(res);
              return;
            }
            writeFinalTextResponse(res);
          })().catch((error: unknown) => {
            if (!res.destroyed) {
              res.writeHead(500, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: { message: String(error) } }));
            }
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
        );
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            entries: { main: { default: true } },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: "openclaw-124084-proof-token" } },
          // Force Tool Search "tools" mode (root-level tools.toolSearch, not
          // per-agent) so tool_call/tool_describe are genuinely exposed and
          // session_status is catalog-hidden -- the exact shape that forces
          // the dispatcher path in production
          // (resolveAgentToolSurfacePlan -> applyToolSearchCatalog).
          tools: { toolSearch: { enabled: true, mode: "tools" } },
        };
        const sessionKey = "agent:main:openclaw-124084-proof";
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: "openclaw-124084-proof-token",
          clientDisplayName: "openclaw-124084-proof",
        });
        const started = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            message: "Call session_status via tool_call using a nested toolId selector.",
            deliver: false,
            idempotencyKey: "openclaw-124084-proof-turn",
          },
        );
        expect(started.status).toBe("started");
        expect(started.runId).toEqual(expect.any(String));
        await expect(
          gateway.client.request(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });

        // A tool_call validation failure does not terminate the run (its
        // error result carries no `terminate: true`), so a second model
        // request and a final assistant turn happen either way -- the real
        // signal is what the second request's function_call_output for
        // call_proof_tool_call actually carries. Pre-fix, prepareArguments
        // never canonicalizes the nested `toolId` alias into `id`, so the
        // outer tool_call schema check rejects the selector-less payload and
        // the model is handed the schema-validation error text verbatim
        // (packages/llm-core/src/validation.ts's
        // `Validation failed for tool "tool_call"` message) instead of a
        // session_status result. Post-fix, the recovered call reaches
        // session_status and the model is handed its real, successful
        // result.
        expect(requests.length).toBeGreaterThanOrEqual(2);
        const secondRequestInput = requests[1]?.input;
        const followUpItems: Record<string, unknown>[] = Array.isArray(secondRequestInput)
          ? secondRequestInput.filter((item): item is Record<string, unknown> => isRecord(item))
          : [];
        const toolCallOutputItem = followUpItems.find(
          (item) => item.type === "function_call_output" && item.call_id === "call_proof_tool_call",
        );
        expect(toolCallOutputItem).toBeDefined();
        const rawOutput = toolCallOutputItem?.output;
        const toolCallOutputText = typeof rawOutput === "string" ? rawOutput : "";
        expect(toolCallOutputText).not.toContain('Validation failed for tool "tool_call"');
        expect(toolCallOutputText).toContain('"ok": true');
        expect(toolCallOutputText).toContain("session_status");
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});

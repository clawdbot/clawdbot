import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createGatewayConfigPath,
  nextGatewayId,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { startGatewayServer } from "./server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

describe("Gateway Code Mode clock rollback", () => {
  beforeEach(resetGatewayTestState);

  afterEach(resetGatewayTestState);

  it(
    "preserves a Code Mode approval budget across a wall-clock rollback in a real Gateway",
    { timeout: 120_000 },
    async () => {
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
        prefix: "openclaw-gw-code-mode-clock-",
      });
      const deviceIdentity = loadOrCreateDeviceIdentity({
        path: path.join(
          tempHome,
          ".openclaw",
          "test-device-identities",
          GATEWAY_CLIENT_NAMES.TEST +
            "-" +
            GATEWAY_CLIENT_MODES.TEST +
            "-" +
            process.platform +
            "-none-operator.sqlite",
        ),
      });
      const token = nextGatewayId("code-mode-clock-token");
      const approvalPluginId = "code-mode-clock-proof";
      const approvalPluginPath = path.join(
        workspaceDir,
        ".openclaw",
        "extensions",
        approvalPluginId,
      );
      await fs.mkdir(approvalPluginPath, { recursive: true });
      await fs.writeFile(
        path.join(approvalPluginPath, "openclaw.plugin.json"),
        `${JSON.stringify(
          {
            id: approvalPluginId,
            activation: { onStartup: true },
            contracts: { tools: ["code_mode_clock_approval"] },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(approvalPluginPath, "index.cjs"),
        `module.exports = {
  id: ${JSON.stringify(approvalPluginId)},
  register(api) {
    api.on("before_tool_call", (event) => {
      if (event.toolName !== "code_mode_clock_approval") return;
      return {
        requireApproval: {
          pluginId: ${JSON.stringify(approvalPluginId)},
          title: "Code Mode clock rollback proof",
          description: "Approve the isolated clock rollback proof tool.",
          allowedDecisions: ["allow-once", "deny"],
          timeoutMs: 30_000,
        },
      };
    });
    api.registerTool({
      name: "code_mode_clock_approval",
      label: "Code Mode clock approval",
      description: "A deterministic approval-gated proof tool.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return { content: [{ type: "text", text: "CODE_MODE_APPROVAL_OK" }] };
      },
    });
  },
};
`,
        "utf8",
      );

      let responseCount = 0;
      const responseBodies: Array<{ input?: unknown[] }> = [];
      let approvalId = "";
      let restoreWallClock = () => {};
      const writeSseResponse = (events: Record<string, unknown>[]) =>
        events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") +
        "data: [DONE]\n\n";
      const providerServer = createServer((request, response) => {
        void (async () => {
          if (request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            input?: unknown[];
          };
          responseCount += 1;
          responseBodies.push(body);
          const hasToolOutput = body.input?.some(
            (item) =>
              item &&
              typeof item === "object" &&
              (item as { type?: unknown }).type === "function_call_output",
          );
          let events: Record<string, unknown>[];
          if (!hasToolOutput) {
            const item = {
              type: "function_call",
              id: "fc_code_mode_clock",
              call_id: "call_code_mode_clock",
              name: "exec",
              arguments: JSON.stringify({
                code: "return await code_mode_clock_approval({});",
              }),
              status: "completed",
            };
            events = [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, status: "in_progress", arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                item_id: item.id,
                output_index: 0,
                delta: item.arguments,
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
                  id: "resp_code_mode_clock_call",
                  status: "completed",
                  output: [item],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ];
          } else {
            const finalItem = {
              type: "message",
              id: "msg_code_mode_clock_final",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "CODE_MODE_APPROVAL_COMPLETE",
                  annotations: [],
                },
              ],
            };
            events = [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...finalItem, status: "in_progress", content: [] },
              },
              {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: finalItem.id,
                delta: "CODE_MODE_APPROVAL_COMPLETE",
              },
              {
                type: "response.output_text.done",
                output_index: 0,
                content_index: 0,
                item_id: finalItem.id,
                text: "CODE_MODE_APPROVAL_COMPLETE",
              },
              { type: "response.output_item.done", output_index: 0, item: finalItem },
              {
                type: "response.completed",
                response: {
                  id: "resp_code_mode_clock_final",
                  status: "completed",
                  output: [finalItem],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ];
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(writeSseResponse(events));
        })().catch((error: unknown) => {
          response.writeHead(500).end(String(error));
        });
      });
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const providerAddress = providerServer.address();
      if (!providerAddress || typeof providerAddress === "string") {
        throw new Error("mock OpenAI Responses server did not bind");
      }
      const openaiBaseUrl = "http://127.0.0.1:" + providerAddress.port + "/v1";

      try {
        const configPath = await createGatewayConfigPath(tempHome);
        const mockProvider = buildMockOpenAiResponsesProvider(openaiBaseUrl);
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              model: { primary: mockProvider.modelRef },
              models: {
                [mockProvider.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
              skipBootstrap: true,
            },
            entries: { main: { default: true } },
          },
          plugins: { allow: [approvalPluginId] },
          tools: {
            profile: "full",
            codeMode: { enabled: true, timeoutMs: 10_000 },
            alsoAllow: ["code_mode_clock_approval"],
          },
          models: {
            mode: "replace",
            providers: { [mockProvider.providerId]: mockProvider.config },
          },
          gateway: { auth: { mode: "token", token } },
        };
        await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
        setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        const port = await getGatewayE2ePortBlock();
        const server = await startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        });
        const client = await connectGatewayClient({
          url: "ws://127.0.0.1:" + port,
          token,
          clientName: GATEWAY_CLIENT_NAMES.TUI,
          clientDisplayName: "code-mode-clock-proof",
          mode: GATEWAY_CLIENT_MODES.UI,
          scopes: ["operator.admin", "operator.approvals"],
          caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
          deviceIdentity,
          onEvent: (event) => {
            if (
              event.event !== "plugin.approval.requested" &&
              event.event !== "plugin.approval.resolved"
            ) {
              return;
            }
            const payload = event.payload;
            if (!payload || typeof payload !== "object") {
              return;
            }
            const request = (payload as { request?: unknown }).request;
            if (event.event === "plugin.approval.requested") {
              if (!request || typeof request !== "object") {
                return;
              }
              if ((request as { pluginId?: unknown }).pluginId !== approvalPluginId) {
                return;
              }
            }
            const id = (payload as { id?: unknown }).id;
            if (typeof id === "string") {
              approvalId = id;
            }
            if (event.event === "plugin.approval.resolved" && id === approvalId) {
              restoreWallClock();
            }
          },
        });
        try {
          await server.startupSettled;
          const sessionKey = "agent:main:code-mode-clock";
          const runId = nextGatewayId("code-mode-clock-run");
          const started = (await client.request(
            "chat.send",
            {
              sessionKey,
              idempotencyKey: runId,
              message: "Run the Code Mode approval proof once.",
              deliver: false,
              originatingChannel: "tui",
              originatingTo: "clock-proof",
            },
            { expectFinal: false },
          )) as { runId?: string; status?: string };
          expect(started.status).toBe("started");
          expect(started.runId).toBeTruthy();

          await vi.waitFor(
            () => {
              expect(approvalId).toBeTruthy();
            },
            { timeout: 30_000, interval: 20 },
          );

          const wallClockBeforeRollback = Date.now();
          const wallClock = vi.spyOn(Date, "now").mockReturnValue(wallClockBeforeRollback - 5_000);
          restoreWallClock = () => wallClock.mockRestore();
          try {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 50);
            });
            await expect(
              client.request("plugin.approval.resolve", {
                id: approvalId,
                decision: "allow-once",
              }),
            ).resolves.toEqual({ ok: true });
          } finally {
            restoreWallClock();
          }

          const completed = await client.request<{ status?: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          );
          expect(completed.status).toBe("ok");
          const history = await client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey,
          });
          expect(JSON.stringify(history.messages)).toContain("CODE_MODE_APPROVAL_COMPLETE");
          expect(responseCount).toBe(2);
          const secondRequest = responseBodies[1];
          const completedCodeModeOutput = secondRequest?.input?.find(
            (item) =>
              item &&
              typeof item === "object" &&
              (item as { type?: unknown }).type === "function_call_output",
          );
          expect(completedCodeModeOutput).toMatchObject({
            type: "function_call_output",
            output: expect.any(String),
          });
          const completedCodeModeResult = JSON.parse(
            String((completedCodeModeOutput as { output?: unknown }).output),
          ) as { status?: unknown };
          expect(completedCodeModeResult.status).toBe("completed");
        } finally {
          await disconnectGatewayClient(client);
          await server.close({ reason: "Code Mode clock rollback proof complete" });
        }
      } finally {
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );
});

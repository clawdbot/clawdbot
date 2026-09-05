// QA Lab proof for direct Gateway tool invocation across HTTP and WebSocket RPC.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../../src/config/config.js";
import { READ_SCOPE, WRITE_SCOPE } from "../../../../src/gateway/operator-scopes.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
  testState,
} from "../../../../src/gateway/test-helpers.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../../src/plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../../src/plugins/hooks.test-helpers.js";

installGatewayTestHooks();

const GATEWAY_TOKEN = "qa-direct-tool-invoke-token";
const AGENTS_LIST_ARGS = {
  name: "agents_list",
  args: {},
  sessionKey: "main",
};

type JsonRecord = Record<string, unknown>;

type ToolsInvokeResult = {
  ok: boolean;
  toolName: string;
  output?: unknown;
  requiresApproval?: boolean;
  source?: string;
  error?: { code?: string; message?: string };
};

function readToolCallId(value: unknown): string {
  const toolCallId =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { toolCallId?: unknown }).toolCallId
      : undefined;
  if (typeof toolCallId !== "string") {
    throw new Error("before_tool_call event omitted toolCallId");
  }
  return toolCallId;
}

async function postInvoke(params: {
  port: number;
  body: string | JsonRecord;
  token?: string;
  scopes?: string;
}) {
  const response = await fetch(`http://127.0.0.1:${params.port}/tools/invoke`, {
    method: "POST",
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      "content-type": "application/json",
      ...(params.scopes ? { "x-openclaw-scopes": params.scopes } : {}),
    },
    body: typeof params.body === "string" ? params.body : JSON.stringify(params.body),
  });
  return { response, body: (await response.json()) as JsonRecord };
}

function expectAgentsListResult(value: unknown): void {
  expect(value).toEqual(
    expect.objectContaining({
      details: expect.objectContaining({
        requester: "main",
        allowAny: false,
        agents: [expect.objectContaining({ id: "main", configured: true })],
      }),
    }),
  );
}

afterEach(() => {
  resetGlobalHookRunner();
});

describe("Gateway direct tool invoke product proof", () => {
  it(
    "enforces public auth, invocation, approval, and call-id contracts",
    { timeout: 60_000 },
    async () => {
      const port = await getGatewayTestPort();
      const configPath = createConfigIO().configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: {
              mode: "local",
              port,
              auth: { mode: "token", token: GATEWAY_TOKEN },
              tools: { allow: ["nodes"] },
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
          main: { default: true, tools: { allow: ["agents_list", "nodes"] } },
        },
      };

      const observedToolCallIds: string[] = [];
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            handler: (event) => {
              observedToolCallIds.push(readToolCallId(event));
            },
          },
        ]),
      );

      let gateway: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
      let readOnlyClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      let writeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

      try {
        gateway = await startTestGatewayServer(port, {
          host: "127.0.0.1",
          auth: { mode: "token", token: GATEWAY_TOKEN },
          controlUiEnabled: false,
        });

        const missingToken = await postInvoke({
          port,
          body: { tool: "agents_list", args: {}, sessionKey: "main" },
        });
        expect(missingToken.response.status).toBe(401);
        expect(missingToken.body).toEqual({
          error: { message: "Unauthorized", type: "unauthorized" },
        });

        const invalidToken = await postInvoke({
          port,
          token: "wrong-token",
          body: { tool: "agents_list", args: {}, sessionKey: "main" },
        });
        expect(invalidToken.response.status).toBe(401);
        expect(invalidToken.body).toEqual({
          error: { message: "Unauthorized", type: "unauthorized" },
        });

        const malformedBody = await postInvoke({
          port,
          token: GATEWAY_TOKEN,
          body: "{",
        });
        expect(malformedBody.response.status).toBe(400);
        expect(malformedBody.body).toMatchObject({
          error: { type: "invalid_request_error" },
        });

        const missingName = await postInvoke({
          port,
          token: GATEWAY_TOKEN,
          body: {},
        });
        expect(missingName.response.status).toBe(400);
        expect(missingName.body).toEqual({
          ok: false,
          error: {
            type: "invalid_request",
            message: "tools.invoke requires name",
          },
        });

        const unavailableHttp = await postInvoke({
          port,
          token: GATEWAY_TOKEN,
          body: { tool: "qa_missing_tool", args: {}, sessionKey: "main" },
        });
        expect(unavailableHttp.response.status).toBe(404);
        expect(unavailableHttp.body).toEqual({
          ok: false,
          error: {
            type: "not_found",
            message: "Tool not available: qa_missing_tool",
          },
        });
        expect(observedToolCallIds).toEqual([]);

        readOnlyClient = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: GATEWAY_TOKEN,
          scopes: [READ_SCOPE],
          clientDisplayName: "direct-tool-invoke-read-only",
          deviceFamily: "direct-tool-invoke-read-only",
          requestTimeoutMs: 10_000,
          timeoutMs: 10_000,
        });
        await expect(
          readOnlyClient.request("tools.invoke", AGENTS_LIST_ARGS),
        ).rejects.toMatchObject({
          message: "missing scope: operator.write",
          details: {
            missingScope: "operator.write",
            requiredScopes: ["operator.write"],
          },
        });
        expect(observedToolCallIds).toEqual([]);

        const ownerRestored = await postInvoke({
          port,
          token: GATEWAY_TOKEN,
          scopes: "operator.approvals",
          body: {
            tool: "nodes",
            action: "status",
            args: {},
            sessionKey: "main",
          },
        });
        expect(ownerRestored.response.status).toBe(200);
        expect(ownerRestored.body.ok).toBe(true);
        expect(ownerRestored.body.result).toBeDefined();

        for (let index = 0; index < 2; index += 1) {
          const httpResult = await postInvoke({
            port,
            token: GATEWAY_TOKEN,
            body: {
              tool: "agents_list",
              args: {},
              sessionKey: "main",
              idempotencyKey: "qa-http-stable",
            },
          });
          expect(httpResult.response.status).toBe(200);
          expect(httpResult.body.ok).toBe(true);
          expectAgentsListResult(httpResult.body.result);
        }

        writeClient = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: GATEWAY_TOKEN,
          scopes: [WRITE_SCOPE],
          clientDisplayName: "direct-tool-invoke-writer",
          deviceFamily: "direct-tool-invoke-writer",
          requestTimeoutMs: 10_000,
          timeoutMs: 10_000,
        });
        const unavailableRpc = await writeClient.request<ToolsInvokeResult>("tools.invoke", {
          name: "qa_missing_tool",
          args: {},
          sessionKey: "main",
        });
        expect(unavailableRpc).toEqual({
          ok: false,
          toolName: "qa_missing_tool",
          error: {
            code: "not_found",
            message: "Tool not available: qa_missing_tool",
          },
        });

        for (let index = 0; index < 2; index += 1) {
          const rpcResult = await writeClient.request<ToolsInvokeResult>("tools.invoke", {
            ...AGENTS_LIST_ARGS,
            idempotencyKey: "qa-rpc-stable",
          });
          expect(rpcResult).toMatchObject({
            ok: true,
            toolName: "agents_list",
            source: "core",
          });
          expectAgentsListResult(rpcResult.output);
        }

        // Repeated calls still traverse the hook; this asserts stable IDs, not deduplication.
        expect(observedToolCallIds).toEqual([
          expect.stringMatching(/^http-direct-operator-\d+$/),
          "http-direct-operator-qa-http-stable",
          "http-direct-operator-qa-http-stable",
          "rpc-delegated-qa-rpc-stable",
          "rpc-delegated-qa-rpc-stable",
        ]);

        const approvalToolCallIds: string[] = [];
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_tool_call",
              handler: (event) => {
                const toolCallId = readToolCallId(event);
                approvalToolCallIds.push(toolCallId);
                return toolCallId.startsWith("rpc-")
                  ? {
                      requireApproval: {
                        title: "Direct invoke approval",
                        description: "Operator approval required by QA policy",
                      },
                    }
                  : {
                      block: true,
                      blockReason: "Blocked by QA policy",
                    };
              },
            },
          ]),
        );

        const approvalRpc = await writeClient.request<ToolsInvokeResult>("tools.invoke", {
          ...AGENTS_LIST_ARGS,
          confirm: false,
          idempotencyKey: "qa-rpc-approval",
        });
        expect(approvalRpc).toEqual({
          ok: false,
          toolName: "agents_list",
          requiresApproval: true,
          error: {
            code: "requires_approval",
            message: "Operator approval required by QA policy",
          },
        });

        const blockedHttp = await postInvoke({
          port,
          token: GATEWAY_TOKEN,
          body: {
            tool: "agents_list",
            args: {},
            sessionKey: "main",
            idempotencyKey: "qa-http-blocked",
          },
        });
        expect(blockedHttp.response.status).toBe(403);
        expect(blockedHttp.body).toEqual({
          ok: false,
          error: {
            type: "tool_call_blocked",
            message: "Blocked by QA policy",
            requiresApproval: false,
          },
        });
        expect(approvalToolCallIds).toEqual([
          "rpc-delegated-qa-rpc-approval",
          "http-direct-operator-qa-http-blocked",
        ]);
      } finally {
        if (writeClient) {
          await disconnectGatewayClient(writeClient);
        }
        if (readOnlyClient) {
          await disconnectGatewayClient(readOnlyClient);
        }
        await gateway?.close({ reason: "Gateway direct tool invoke QA proof complete" });
      }
    },
  );
});

// Canvas QA proof crosses the registered agent tool and a real Gateway/node socket.
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import canvasPlugin from "../../../../extensions/canvas/index.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../../../src/plugins/runtime.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";

const E2E_TIMEOUT_MS = 180_000;
const SESSION_KEY = "agent:main:canvas-node-qa";
const PNG_FIXTURE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUkcAAAAASUVORK5CYII=";
const VALID_A2UI_JSONL = [
  JSON.stringify({
    surfaceUpdate: {
      surfaceId: "main",
      components: [
        {
          id: "root",
          component: { Text: { text: { literalString: "Canvas node proof" } } },
        },
      ],
    },
  }),
  JSON.stringify({ beginRendering: { surfaceId: "main", root: "root" } }),
].join("\n");
const CANVAS_NODE_COMMANDS = [
  "canvas.present",
  "canvas.hide",
  "canvas.navigate",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
] as const;

type NodeInvokeFrame = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON: string | null;
  timeoutMs: number;
  idempotencyKey: string;
};

type CapturedInvocation = {
  nodeId: string;
  command: string;
  params: unknown;
  timeoutMs: number;
  idempotencyKey: string;
};

const actions = [
  {
    args: {
      action: "present",
      target: "https://canvas.test/present",
      x: 12,
      y: 34,
      width: 640,
      height: 480,
      timeoutMs: 5_001,
    },
    command: "canvas.present",
    params: {
      url: "https://canvas.test/present",
      placement: { x: 12, y: 34, width: 640, height: 480 },
    },
  },
  {
    args: { action: "hide", timeoutMs: 5_002 },
    command: "canvas.hide",
    params: null,
  },
  {
    args: {
      action: "navigate",
      url: "https://canvas.test/navigate",
      timeoutMs: 5_003,
    },
    command: "canvas.navigate",
    params: { url: "https://canvas.test/navigate" },
  },
  {
    args: { action: "eval", javaScript: "document.title", timeoutMs: 5_004 },
    command: "canvas.eval",
    params: { javaScript: "document.title" },
  },
  {
    args: {
      action: "snapshot",
      outputFormat: "png",
      maxWidth: 720,
      quality: 0.8,
      timeoutMs: 5_005,
    },
    command: "canvas.snapshot",
    params: { format: "png", maxWidth: 720, quality: 0.8 },
  },
  {
    args: { action: "a2ui_push", jsonl: VALID_A2UI_JSONL, timeoutMs: 5_006 },
    command: "canvas.a2ui.pushJSONL",
    params: { jsonl: VALID_A2UI_JSONL },
  },
  {
    args: { action: "a2ui_reset", timeoutMs: 5_007 },
    command: "canvas.a2ui.reset",
    params: null,
  },
] as const;

describe("Canvas agent tool over a paired Linux node", () => {
  it(
    "forwards every registered Canvas action with its invocation context",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const state = await createOpenClawTestState({
        label: "qa-canvas-agent-node",
        layout: "home",
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_FAST: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        },
      });
      const port = await getFreeGatewayPort();
      const gatewayToken = "qa-canvas-agent-node-token";
      const config: OpenClawConfig = {
        gateway: {
          mode: "local",
          port,
          bind: "loopback",
          auth: { mode: "token", token: gatewayToken },
          controlUi: { enabled: false },
        },
        agents: {
          defaults: { heartbeat: { every: "0m" }, skipBootstrap: true },
          entries: { main: { default: true, tools: { allow: ["canvas"] } } },
        },
        plugins: {
          allow: ["canvas"],
          entries: { canvas: { enabled: true } },
        },
      };
      await state.writeConfig(config);

      const invocations: CapturedInvocation[] = [];
      const handlerErrors: Error[] = [];
      const snapshotPaths: string[] = [];
      const previousPluginRegistry = captureActivePluginRegistrySnapshot();
      let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      let operatorClient: GatewayClient | undefined;
      let nodeClient: GatewayClient | undefined;

      try {
        const { registry } = createPluginRegistryFixture(config);
        registerVirtualTestPlugin({
          registry,
          config,
          id: canvasPlugin.id,
          name: canvasPlugin.name,
          source: "extensions/canvas/index.ts",
          contracts: { tools: ["canvas"] },
          register(api) {
            canvasPlugin.register?.(api);
          },
        });
        expect(registry.registry.tools.map((entry) => entry.pluginId)).toEqual(["canvas"]);
        expect(registry.registry.nodeInvokePolicies).toEqual([
          expect.objectContaining({
            pluginId: "canvas",
            policy: expect.objectContaining({
              commands: [...CANVAS_NODE_COMMANDS],
              defaultPlatforms: expect.arrayContaining(["linux"]),
            }),
          }),
        ]);
        setActivePluginRegistry(
          registry.registry,
          "canvas-agent-node-e2e",
          "default",
          state.workspaceDir,
        );
        gateway = await startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token: gatewayToken },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        const operatorIdentity = loadOrCreateDeviceIdentity({
          path: path.join(state.home, "canvas-operator.sqlite"),
        });
        const nodeIdentity = loadOrCreateDeviceIdentity({
          path: path.join(state.home, "canvas-linux-node.sqlite"),
        });
        operatorClient = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: gatewayToken,
          clientName: GATEWAY_CLIENT_NAMES.TEST,
          clientDisplayName: "canvas-node-operator",
          clientVersion: "1.0.0",
          platform: "linux",
          mode: GATEWAY_CLIENT_MODES.TEST,
          role: "operator",
          scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
          deviceIdentity: operatorIdentity,
          requestTimeoutMs: 60_000,
          timeoutMs: 60_000,
        });
        const nodeId = nodeIdentity.deviceId;
        nodeClient = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: gatewayToken,
          clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
          clientDisplayName: "canvas-linux-node",
          clientVersion: "1.0.0",
          platform: "linux",
          mode: GATEWAY_CLIENT_MODES.NODE,
          role: "node",
          scopes: [],
          caps: ["canvas"],
          commands: [...CANVAS_NODE_COMMANDS],
          deviceIdentity: nodeIdentity,
          requestTimeoutMs: 60_000,
          timeoutMs: 60_000,
          timeoutMessage: "timeout waiting for Canvas Linux node",
          onEvent: (event) => {
            if (event.event !== "node.invoke.request") {
              return;
            }
            void respondToCanvasInvocation({
              client: nodeClient,
              expectedNodeId: nodeId,
              frame: event.payload,
              invocations,
            }).catch((error: unknown) => {
              handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
            });
          },
        });
        await approveCanvasNodeCommands(operatorClient, nodeId);
        await waitForCanvasNode(operatorClient, nodeId);

        const toolRegistration = registry.registry.tools.find(
          (entry) => entry.pluginId === "canvas",
        );
        const registeredTools = toolRegistration?.factory({
          config,
          runtimeConfig: config,
          getRuntimeConfig: () => config,
          workspaceDir: state.workspaceDir,
          sessionKey: SESSION_KEY,
        });
        const canvasTool = Array.isArray(registeredTools)
          ? registeredTools.find((tool) => tool.name === "canvas")
          : registeredTools;
        if (!canvasTool?.execute) {
          throw new Error("expected registered Canvas agent tool");
        }

        for (const action of actions) {
          let result: Awaited<ReturnType<NonNullable<typeof canvasTool.execute>>>;
          try {
            result = await canvasTool.execute(`canvas-${action.command}`, {
              ...action.args,
              node: nodeId,
              gatewayUrl: `ws://127.0.0.1:${port}`,
              gatewayToken,
            });
          } catch (error) {
            throw new Error(
              `Canvas ${action.command} failed after ${invocations.length} node request(s); handler errors: ${handlerErrors.map((entry) => entry.message).join("; ") || "none"}`,
              { cause: error },
            );
          }
          if (action.command === "canvas.eval") {
            expect(result.details).toEqual({ result: "canvas-eval-result" });
          }
          if (action.command === "canvas.snapshot") {
            expect(result.details).toMatchObject({
              format: "png",
              media: { outbound: false },
            });
            const snapshotPath = (result.details as { path?: unknown } | undefined)?.path;
            if (typeof snapshotPath === "string") {
              snapshotPaths.push(snapshotPath);
            }
          }
        }

        expect(handlerErrors).toEqual([]);
        expect(invocations).toHaveLength(actions.length);
        expect(
          invocations.map(
            ({ nodeId: _nodeId, idempotencyKey: _key, timeoutMs: _timeout, ...invocation }) =>
              invocation,
          ),
        ).toEqual(
          actions.map((action) => ({
            command: action.command,
            params: action.params,
          })),
        );
        expect(invocations.every((invocation) => invocation.nodeId === nodeId)).toBe(true);
        for (const [index, invocation] of invocations.entries()) {
          expect(invocation.timeoutMs).toBeGreaterThan(0);
          expect(invocation.timeoutMs).toBeLessThanOrEqual(actions[index]?.args.timeoutMs ?? 0);
        }
        expect(
          invocations.every((invocation) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
              invocation.idempotencyKey,
            ),
          ),
        ).toBe(true);
        expect(new Set(invocations.map((invocation) => invocation.idempotencyKey)).size).toBe(
          actions.length,
        );
      } finally {
        await Promise.allSettled(snapshotPaths.map((snapshotPath) => rm(snapshotPath)));
        if (nodeClient) {
          await disconnectGatewayClient(nodeClient);
        }
        if (operatorClient) {
          await disconnectGatewayClient(operatorClient);
        }
        if (gateway) {
          await gateway.close({ reason: "canvas agent node proof complete" });
        }
        restoreActivePluginRegistrySnapshot(previousPluginRegistry);
        await state.cleanup();
      }
    },
  );
});

async function approveCanvasNodeCommands(operator: GatewayClient, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        pending?: Array<{ requestId?: string; nodeId?: string; commands?: string[] }>;
      }>("node.pair.list", {});
      const pending = result.pending?.find((entry) => entry.nodeId === nodeId);
      expect(pending?.commands).toEqual([...CANVAS_NODE_COMMANDS]);
      expect(pending?.requestId).toEqual(expect.any(String));
      await operator.request("node.pair.approve", { requestId: pending?.requestId });
    },
    { timeout: 15_000, interval: 100 },
  );
}

async function waitForCanvasNode(operator: GatewayClient, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
      }>("node.list", {});
      const node = result.nodes?.find((entry) => entry.nodeId === nodeId && entry.connected);
      expect(node).toBeDefined();
      expect(node?.commands).toEqual(expect.arrayContaining([...CANVAS_NODE_COMMANDS]));
    },
    { timeout: 15_000, interval: 100 },
  );
}

async function respondToCanvasInvocation(params: {
  client: GatewayClient | undefined;
  expectedNodeId: string;
  frame: unknown;
  invocations: CapturedInvocation[];
}): Promise<void> {
  const frame = params.frame as Partial<NodeInvokeFrame>;
  const invalidFields = [
    !params.client ? "client" : "",
    typeof frame.id !== "string" ? "id" : "",
    frame.nodeId !== params.expectedNodeId ? "nodeId" : "",
    typeof frame.command !== "string" ? "command" : "",
    typeof frame.timeoutMs !== "number" ? "timeoutMs" : "",
    typeof frame.idempotencyKey !== "string" ? "idempotencyKey" : "",
    !(frame.paramsJSON === null || typeof frame.paramsJSON === "string") ? "paramsJSON" : "",
  ].filter(Boolean);
  if (invalidFields.length > 0) {
    throw new Error(
      `Gateway sent invalid Canvas node fields: ${invalidFields.join(", ")}; payload=${JSON.stringify(frame)}`,
    );
  }
  const client = params.client;
  if (
    !client ||
    typeof frame.id !== "string" ||
    frame.nodeId !== params.expectedNodeId ||
    typeof frame.command !== "string" ||
    typeof frame.timeoutMs !== "number" ||
    typeof frame.idempotencyKey !== "string" ||
    !(frame.paramsJSON === null || typeof frame.paramsJSON === "string")
  ) {
    throw new Error(`invalid Canvas node invocation: ${JSON.stringify(frame)}`);
  }
  const invocation: CapturedInvocation = {
    nodeId: frame.nodeId,
    command: frame.command,
    params: frame.paramsJSON === null ? null : JSON.parse(frame.paramsJSON),
    timeoutMs: frame.timeoutMs,
    idempotencyKey: frame.idempotencyKey,
  };
  params.invocations.push(invocation);

  const responseByCommand: Record<string, unknown> = {
    "canvas.present": { presented: true },
    "canvas.hide": { hidden: true },
    "canvas.navigate": { navigated: true },
    "canvas.eval": { result: "canvas-eval-result" },
    "canvas.snapshot": { format: "png", base64: PNG_FIXTURE_BASE64 },
    "canvas.a2ui.pushJSONL": { accepted: true },
    "canvas.a2ui.reset": { reset: true },
  };
  if (!Object.hasOwn(responseByCommand, frame.command)) {
    throw new Error(`unexpected Canvas node command: ${frame.command}`);
  }
  await client.request("node.invoke.result", {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: true,
    payloadJSON: JSON.stringify(responseByCommand[frame.command]),
  });
}

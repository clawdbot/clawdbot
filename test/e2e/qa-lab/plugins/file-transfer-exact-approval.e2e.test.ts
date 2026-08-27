// Proves exact file grants across the registered plugin policy and real node transport.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import fileTransferPlugin from "../../../../extensions/file-transfer/index.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
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
const FILE_FETCH_COMMAND = "file.fetch";

type NodeInvokeFrame = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON: string | null;
};

type CapturedInvocation = {
  command: string;
  params: Record<string, unknown>;
};

describe("file-transfer exact approval transport", () => {
  it("rejects a replaced file before final I/O", { timeout: E2E_TIMEOUT_MS }, async () => {
    const state = await createOpenClawTestState({
      label: "qa-file-transfer-exact-approval",
      layout: "home",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
    });
    const port = await getGatewayE2ePortBlock();
    const gatewayToken = "qa-file-transfer-exact-approval-token";
    const target = path.join(state.home, "report.txt");
    const approvedObject = path.join(state.home, "approved-object.txt");
    await fs.writeFile(target, "approved");
    const canonicalPath = await fs.realpath(target);
    const operatorIdentity = loadOrCreateDeviceIdentity({
      path: path.join(state.home, "operator.sqlite"),
    });
    const nodeIdentity = loadOrCreateDeviceIdentity({
      path: path.join(state.home, "node.sqlite"),
    });
    const nodeId = nodeIdentity.deviceId;
    const config: OpenClawConfig = {
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token", token: gatewayToken },
        controlUi: { enabled: false },
        nodes: { commands: { allow: [FILE_FETCH_COMMAND] } },
      },
      agents: {
        defaults: { heartbeat: { every: "0m" }, skipBootstrap: true },
      },
      plugins: {
        allow: ["file-transfer"],
        entries: {
          "file-transfer": {
            enabled: true,
            config: {
              policyVersion: 2,
              nodes: { [nodeId]: { ask: "on-miss" } },
              literalGrants: [
                {
                  nodeId,
                  command: FILE_FETCH_COMMAND,
                  requestedPath: target,
                  canonicalPath,
                },
              ],
            },
          },
        },
      },
    };
    await state.writeConfig(config);

    const command = fileTransferPlugin.nodeHostCommands?.find(
      (entry) => entry.command === FILE_FETCH_COMMAND,
    );
    if (!command) {
      throw new Error("file-transfer plugin omitted file.fetch");
    }

    const previousPluginRegistry = captureActivePluginRegistrySnapshot();
    const invocations: CapturedInvocation[] = [];
    const handlerErrors: Error[] = [];
    const invocationResponses: Promise<void>[] = [];
    let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let operator: GatewayClient | undefined;
    let node: GatewayClient | undefined;
    let replaced = false;

    try {
      const { registry } = createPluginRegistryFixture(config);
      registerVirtualTestPlugin({
        registry,
        config,
        id: fileTransferPlugin.id,
        name: fileTransferPlugin.name,
        source: "extensions/file-transfer/index.ts",
        register(api) {
          fileTransferPlugin.register?.(api);
        },
      });
      expect(registry.registry.nodeInvokePolicies).toEqual([
        expect.objectContaining({
          pluginId: "file-transfer",
          policy: expect.objectContaining({
            commands: [FILE_FETCH_COMMAND, "dir.list", "dir.fetch", "file.write"],
          }),
        }),
      ]);
      setActivePluginRegistry(
        registry.registry,
        "file-transfer-exact-approval-e2e",
        "default",
        state.workspaceDir,
      );
      gateway = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token: gatewayToken },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      operator = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: gatewayToken,
        clientName: GATEWAY_CLIENT_NAMES.TEST,
        clientDisplayName: "file-transfer-operator",
        clientVersion: "1.0.0",
        platform: "linux",
        mode: GATEWAY_CLIENT_MODES.TEST,
        role: "operator",
        scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
        deviceIdentity: operatorIdentity,
        requestTimeoutMs: 60_000,
        timeoutMs: 60_000,
      });
      node = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: gatewayToken,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientDisplayName: "file-transfer-node",
        clientVersion: "1.0.0",
        platform: process.platform,
        mode: GATEWAY_CLIENT_MODES.NODE,
        role: "node",
        scopes: [],
        caps: ["file"],
        commands: [FILE_FETCH_COMMAND],
        deviceIdentity: nodeIdentity,
        requestTimeoutMs: 60_000,
        timeoutMs: 60_000,
        onEvent: (event) => {
          if (event.event !== "node.invoke.request") {
            return;
          }
          const response = respondToFileFetch({
            client: node,
            frame: event.payload,
            command,
            invocations,
            beforePreflightResponse: async () => {
              if (replaced) {
                return;
              }
              replaced = true;
              await fs.rename(target, approvedObject);
              await fs.writeFile(target, "replacement");
            },
          }).catch((error: unknown) => {
            handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
          });
          invocationResponses.push(response);
        },
      });
      await approveNode(operator, nodeId);
      await waitForNode(operator, nodeId);

      const result = await operator.request<{
        payload?: { ok?: boolean; code?: string };
      }>("node.invoke", {
        nodeId,
        command: FILE_FETCH_COMMAND,
        params: { path: target },
        timeoutMs: 60_000,
        idempotencyKey: randomUUID(),
      });

      expect(invocations).toHaveLength(2);
      expect(invocations[0]).toEqual({
        command: FILE_FETCH_COMMAND,
        params: expect.objectContaining({
          path: target,
          preflightOnly: true,
          followSymlinks: false,
          expectedCanonicalPath: canonicalPath,
        }),
      });
      expect(invocations[1]).toEqual({
        command: FILE_FETCH_COMMAND,
        params: expect.objectContaining({
          path: target,
          expectedCanonicalPath: canonicalPath,
          expectedBinding: expect.objectContaining({ kind: "existing" }),
        }),
      });
      expect(result.payload).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
      await expect(fs.readFile(approvedObject, "utf8")).resolves.toBe("approved");
      await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
      await Promise.all(invocationResponses);
      expect(handlerErrors).toEqual([]);
    } finally {
      await Promise.all(invocationResponses);
      if (node) {
        await disconnectGatewayClient(node);
      }
      if (operator) {
        await disconnectGatewayClient(operator);
      }
      if (gateway) {
        await gateway.close({ reason: "file-transfer exact approval proof complete" });
      }
      restoreActivePluginRegistrySnapshot(previousPluginRegistry);
      await state.cleanup();
    }
  });
});

async function approveNode(operator: GatewayClient, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        pending?: Array<{ requestId?: string; nodeId?: string; commands?: string[] }>;
      }>("node.pair.list", {});
      const pending = result.pending?.find((entry) => entry.nodeId === nodeId);
      expect(pending?.commands).toEqual([FILE_FETCH_COMMAND]);
      expect(pending?.requestId).toEqual(expect.any(String));
      await operator.request("node.pair.approve", { requestId: pending?.requestId });
    },
    { timeout: 15_000, interval: 100 },
  );
}

async function waitForNode(operator: GatewayClient, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
      }>("node.list", {});
      const node = result.nodes?.find((entry) => entry.nodeId === nodeId && entry.connected);
      expect(node?.commands).toEqual([FILE_FETCH_COMMAND]);
    },
    { timeout: 15_000, interval: 100 },
  );
}

async function respondToFileFetch(params: {
  client: GatewayClient | undefined;
  frame: unknown;
  command: NonNullable<(typeof fileTransferPlugin)["nodeHostCommands"]>[number];
  invocations: CapturedInvocation[];
  beforePreflightResponse: () => Promise<void>;
}): Promise<void> {
  const frame = params.frame as Partial<NodeInvokeFrame>;
  if (
    !params.client ||
    typeof frame.id !== "string" ||
    typeof frame.nodeId !== "string" ||
    frame.command !== FILE_FETCH_COMMAND ||
    !(frame.paramsJSON === null || typeof frame.paramsJSON === "string")
  ) {
    throw new Error(`invalid file.fetch node invocation: ${JSON.stringify(frame)}`);
  }
  const commandParams = JSON.parse(frame.paramsJSON ?? "{}") as Record<string, unknown>;
  params.invocations.push({ command: frame.command, params: commandParams });
  const payloadJSON = await params.command.handle(frame.paramsJSON);
  if (commandParams.preflightOnly === true) {
    await params.beforePreflightResponse();
  }
  await params.client.request("node.invoke.result", {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: true,
    payloadJSON,
  });
}

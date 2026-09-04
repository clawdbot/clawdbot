import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.ts";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { createQaGatewayChild } from "../api.ts";

const COMMAND = "codex.exec-server.stdio.v1";
const MODEL = "openai/gpt-5.6-luna";
const NODE_RUNNER_INVENTORY_UPDATE_METHOD = "node.runnerInventory.update";
const NODE_WORKER_ENVIRONMENT_SESSION_VERSION = 1;
const NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE = "node-worker-supervisor-v6";
const REQUEST_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 180_000;
const helloCounts = new WeakMap<GatewayClient, number>();

const gatewayOwners: ReturnType<typeof createQaGatewayChild>[] = [];
type DeviceIdentity = {
  deviceId: string;
  privateKeyPem: string;
  publicKeyPem: string;
};

afterEach(async () => {
  for (const owner of gatewayOwners.splice(0)) {
    const stopped = await owner.stop();
    if (stopped.errors.length > 0) {
      throw new AggregateError(stopped.errors, "QA Gateway cleanup failed");
    }
  }
});

const suite = createControlUiE2eSuite({
  name: "Session host command state with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

suite.define(() => {
  it(
    "shows the next action for every required node command state",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const gatewayOwner = createQaGatewayChild();
      gatewayOwners.push(gatewayOwner);
      const gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        useRepoCli: true,
        transportBaseUrl: "http://127.0.0.1",
        providerMode: "mock-openai",
        providerBaseUrl: "http://127.0.0.1:9/v1",
        primaryModel: MODEL,
        alternateModel: MODEL,
        forcedRuntime: "codex",
        enabledPluginIds: ["codex"],
        controlUiEnabled: false,
        mutateConfig: (config) => ({
          ...config,
          gateway: {
            ...config.gateway,
            auth: { mode: "none" },
            controlUi: {
              ...config.gateway?.controlUi,
              allowedOrigins: [new URL(suite.server.baseUrl).origin],
              enabled: false,
            },
            nodes: {
              ...config.gateway?.nodes,
              commands: { allow: [COMMAND] },
              pairing: {
                ...config.gateway?.nodes?.pairing,
                autoApproveLocal: false,
                sshVerify: false,
              },
            },
            reload: { mode: "hybrid" },
          },
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              models: {
                ...config.agents?.defaults?.models,
                [MODEL]: { agentRuntime: { id: "codex" } },
              },
            },
          },
        }),
      });
      const operator = await connectOperator(gateway);
      const clients: GatewayClient[] = [operator];
      try {
        const undeclaredIdentity = createDeviceIdentity();
        const pendingIdentity = createDeviceIdentity();
        const unauthorizedIdentity = createDeviceIdentity();

        const undeclaredNode = await connectPairedNode({
          displayName: "Undeclared command",
          gateway,
          identity: undeclaredIdentity,
          operator,
          commands: [],
        });
        clients.push(undeclaredNode);
        await publishSessionHost(undeclaredNode);
        const pendingApproved = await connectPairedNode({
          displayName: "Pending approval",
          gateway,
          identity: pendingIdentity,
          operator,
          commands: [],
        });
        await pendingApproved.stopAndWait({ timeoutMs: 1_000 });
        const pendingNode = await connectNode({
          displayName: "Pending approval",
          gateway,
          identity: pendingIdentity,
          commands: [COMMAND],
        });
        clients.push(pendingNode);
        await publishSessionHost(pendingNode);
        await waitForPendingCommand(operator, pendingIdentity.deviceId);
        const unauthorizedNode = await connectPairedNode({
          displayName: "Unauthorized command",
          gateway,
          identity: unauthorizedIdentity,
          operator,
          commands: [COMMAND],
        });
        clients.push(unauthorizedNode);
        await publishSessionHost(unauthorizedNode);

        const readCommandState = async (deviceId: string) => {
          const inventory = await operator.request<{
            environments: Array<{
              id: string;
              requiredNodeCommand?: { command: string; state: string };
            }>;
          }>("environments.list", { runtimeId: "codex" });
          return inventory.environments.find((environment) => environment.id === `node:${deviceId}`)
            ?.requiredNodeCommand;
        };
        expect(await readCommandState(undeclaredIdentity.deviceId)).toEqual({
          command: COMMAND,
          state: "undeclared",
        });
        expect(await readCommandState(pendingIdentity.deviceId)).toEqual({
          command: COMMAND,
          state: "pending-approval",
        });
        expect(await readCommandState(unauthorizedIdentity.deviceId)).toEqual({
          command: COMMAND,
          state: "invocable",
        });

        await suite.withPage(
          {
            locale: "en-US",
            recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1440 } },
            serviceWorkers: "block",
            viewport: { height: 900, width: 1440 },
          },
          async ({ page }) => {
            const url = new URL("new", suite.server.baseUrl);
            url.searchParams.set("gatewayUrl", gateway.wsUrl);
            await page.goto(url.toString());
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();

            await page.locator("#new-session-where-trigger").click();
            const place = page.locator("wa-popover.new-session-page__where-popover");
            const row = (deviceId: string) => place.locator(`[data-value="device:${deviceId}"]`);
            const facts = async (deviceId: string) =>
              await row(deviceId).locator(".new-session-page__menu-fact").allTextContents();

            await row(undeclaredIdentity.deviceId).waitFor();
            expect(await facts(undeclaredIdentity.deviceId)).toContain(
              `Make ${COMMAND} available on this device, then reconnect, or pick another device.`,
            );
            await expect
              .poll(() => facts(pendingIdentity.deviceId))
              .toContain(
                `Ask an administrator to approve the pending ${COMMAND} request, or pick another device.`,
              );
            // Keep captures at the recorded viewport size: clips and larger full-page
            // screenshots temporarily resize Chromium's shared screencast surface.
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, "00-undeclared.png"),
            });
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, "01-pending-approval.png"),
            });
            await page.keyboard.press("Escape");

            const beforeConfig = await operator.request<{ hash: string }>("config.get", {});
            const unauthorizedHelloCount = helloCounts.get(unauthorizedNode) ?? 0;
            await operator.request("config.patch", {
              raw: JSON.stringify({
                gateway: { nodes: { commands: { allow: [], deny: [COMMAND] } } },
              }),
              baseHash: beforeConfig.hash,
              replacePaths: ["gateway.nodes.commands.allow", "gateway.nodes.commands.deny"],
            });
            await vi.waitFor(
              async () => {
                expect(await readCommandState(unauthorizedIdentity.deviceId)).toEqual({
                  command: COMMAND,
                  state: "unauthorized",
                });
              },
              { interval: 250, timeout: 60_000 },
            );
            expect(helloCounts.get(unauthorizedNode)).toBe(unauthorizedHelloCount);

            await page.reload();
            await page.locator("#new-session-where-trigger").click();
            await row(unauthorizedIdentity.deviceId).waitFor();
            await expect
              .poll(() => facts(unauthorizedIdentity.deviceId))
              .toContain(
                `Authorize ${COMMAND} in the Gateway node command policy, or pick another device.`,
              );
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, "02-unauthorized-after-hot-reload.png"),
            });
            expect(helloCounts.get(unauthorizedNode)).toBe(unauthorizedHelloCount);
            await page.keyboard.press("Escape");

            const deniedConfig = await operator.request<{ hash: string }>("config.get", {});
            await operator.request("config.patch", {
              raw: JSON.stringify({
                gateway: { nodes: { commands: { allow: [COMMAND], deny: [] } } },
              }),
              baseHash: deniedConfig.hash,
              replacePaths: ["gateway.nodes.commands.allow", "gateway.nodes.commands.deny"],
            });
            await vi.waitFor(
              async () => {
                expect(await readCommandState(unauthorizedIdentity.deviceId)).toEqual({
                  command: COMMAND,
                  state: "invocable",
                });
                expect(await readCommandState(pendingIdentity.deviceId)).toEqual({
                  command: COMMAND,
                  state: "pending-approval",
                });
              },
              { interval: 250, timeout: 60_000 },
            );
            expect(helloCounts.get(unauthorizedNode)).toBe(unauthorizedHelloCount);
            await page.reload();
            await page.locator("#new-session-where-trigger").click();
            await row(unauthorizedIdentity.deviceId).waitFor();
            expect(await row(unauthorizedIdentity.deviceId).isEnabled()).toBe(true);
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, "03-invocable-after-reallow.png"),
            });
          },
        );
      } finally {
        await Promise.allSettled(
          clients.toReversed().map((client) => client.stopAndWait({ timeoutMs: 1_000 })),
        );
        const tempRoot = gateway.tempRoot;
        const stopped = await gatewayOwner.stop();
        gatewayOwners.splice(gatewayOwners.indexOf(gatewayOwner), 1);
        expect(stopped.errors).toEqual([]);
        expect(existsSync(tempRoot)).toBe(false);
      }
    },
  );
});

type GatewayHandle = Awaited<ReturnType<ReturnType<typeof createQaGatewayChild>["start"]>>;

async function connectOperator(gateway: GatewayHandle): Promise<GatewayClient> {
  return await connectClient({
    gateway,
    role: "operator",
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Session host picker proof operator",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
    deviceIdentity: null,
  });
}

async function connectPairedNode(params: {
  displayName: string;
  gateway: GatewayHandle;
  identity: DeviceIdentity;
  operator: GatewayClient;
  commands: string[];
}): Promise<GatewayClient> {
  try {
    return await connectNode(params);
  } catch (error) {
    if (!isPairingRequired(error)) {
      throw error;
    }
    await approveDevicePairing(params.operator, params.identity.deviceId);
  }
  let pendingClient: GatewayClient | undefined;
  try {
    pendingClient = await connectNode(params);
  } catch (error) {
    if (!isPairingRequired(error)) {
      throw error;
    }
  }
  await approveNodePairing(params.operator, params.identity.deviceId);
  await pendingClient?.stopAndWait({ timeoutMs: 1_000 });
  return await connectNode(params);
}

function isPairingRequired(error: unknown): boolean {
  const details =
    error && typeof error === "object"
      ? (error as { details?: { code?: unknown } }).details
      : undefined;
  return details?.code === "PAIRING_REQUIRED" || String(error).includes("pairing required");
}

async function connectNode(params: {
  displayName: string;
  gateway: GatewayHandle;
  identity: DeviceIdentity;
  commands: string[];
}): Promise<GatewayClient> {
  return await connectClient({
    gateway: params.gateway,
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: params.displayName,
    mode: GATEWAY_CLIENT_MODES.NODE,
    platform: "linux",
    deviceFamily: "Linux",
    scopes: [],
    caps: ["session.host"],
    commands: params.commands,
    deviceIdentity: params.identity,
  });
}

async function connectClient(params: {
  gateway: GatewayHandle;
  role: "operator" | "node";
  clientName: typeof GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT | typeof GATEWAY_CLIENT_NAMES.NODE_HOST;
  clientDisplayName: string;
  mode: typeof GATEWAY_CLIENT_MODES.BACKEND | typeof GATEWAY_CLIENT_MODES.NODE;
  scopes: string[];
  platform?: string;
  deviceFamily?: string;
  caps?: string[];
  commands?: string[];
  deviceIdentity: DeviceIdentity | null;
}): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (client: GatewayClient, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
      } else {
        resolve(client);
      }
    };
    const client = new GatewayClient({
      url: params.gateway.wsUrl,
      token: params.gateway.token,
      env: params.gateway.runtimeEnv,
      role: params.role,
      clientName: params.clientName,
      clientDisplayName: params.clientDisplayName,
      clientVersion: "1.0.0",
      platform: params.platform ?? process.platform,
      deviceFamily: params.deviceFamily,
      mode: params.mode,
      scopes: params.scopes,
      caps: params.caps,
      commands: params.commands,
      deviceIdentity: params.deviceIdentity,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onHelloOk: () => {
        helloCounts.set(client, (helloCounts.get(client) ?? 0) + 1);
        finish(client);
      },
      onConnectError: (error) => finish(client, error),
      onClose: (code, reason) => finish(client, new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () =>
        finish(client, new Error(`Gateway client connection timed out:\n${params.gateway.logs()}`)),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    client.start();
  });
}

async function approveDevicePairing(operator: GatewayClient, nodeId: string): Promise<void> {
  let deviceRequestId = "";
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        pending?: Array<{ deviceId?: string; requestId?: string; role?: string }>;
      }>("device.pair.list", {});
      deviceRequestId =
        result.pending?.find((entry) => entry.deviceId === nodeId || entry.role === "node")
          ?.requestId ?? "";
      expect(deviceRequestId).not.toBe("");
    },
    { interval: 100, timeout: REQUEST_TIMEOUT_MS },
  );
  await operator.request("device.pair.approve", { requestId: deviceRequestId });
}

async function approveNodePairing(operator: GatewayClient, nodeId: string): Promise<void> {
  let nodeRequestId = "";
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        pending?: Array<{ nodeId?: string; requestId?: string }>;
      }>("node.pair.list", {});
      nodeRequestId = result.pending?.find((entry) => entry.nodeId === nodeId)?.requestId ?? "";
      expect(nodeRequestId).not.toBe("");
    },
    { interval: 100, timeout: REQUEST_TIMEOUT_MS },
  );
  await operator.request("node.pair.approve", { requestId: nodeRequestId });
}

async function waitForPendingCommand(operator: GatewayClient, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        pending?: Array<{ commands?: string[]; nodeId?: string }>;
      }>("node.pair.list", {});
      expect(result.pending?.find((entry) => entry.nodeId === nodeId)?.commands).toContain(COMMAND);
    },
    { interval: 100, timeout: REQUEST_TIMEOUT_MS },
  );
}

async function publishSessionHost(node: GatewayClient): Promise<void> {
  await node.request(NODE_RUNNER_INVENTORY_UPDATE_METHOD, {
    protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
    workerHost: {
      enabled: true,
      environmentSession: NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
      capacity: { total: 1, available: 1 },
    },
  });
}

function createDeviceIdentity(): DeviceIdentity {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const publicKeyRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    deviceId: crypto.createHash("sha256").update(publicKeyRaw).digest("hex"),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKeyPem,
  };
}

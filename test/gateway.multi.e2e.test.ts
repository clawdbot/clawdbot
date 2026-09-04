// Gateway multi E2E tests validate multi-gateway runtime behavior.
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/gateway/client.js";
import { connectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import {
  type GatewayInstance,
  connectNode,
  connectGatewayStatusClient,
  postJson,
  spawnGatewayInstance,
  stopGatewayInstance,
  waitForNodeStatus,
} from "./helpers/gateway-e2e-harness.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const E2E_TIMEOUT_MS = 120_000;

const CLOCK_SHIFT_PRELOAD = `
import { existsSync, writeFileSync } from "node:fs";

const shiftPath = process.env.OPENCLAW_CLOCK_SHIFT_PATH;
const shiftReadyPath = process.env.OPENCLAW_CLOCK_SHIFT_READY_PATH;
const offsetMs = Number(process.env.OPENCLAW_CLOCK_SHIFT_MS ?? "0");
const originalNow = Date.now.bind(Date);
const timer = setInterval(() => {
  if (!shiftPath || !existsSync(shiftPath)) {
    return;
  }
  clearInterval(timer);
  Date.now = () => originalNow() + offsetMs;
  if (shiftReadyPath) {
    writeFileSync(shiftReadyPath, "ready\\n");
  }
  process.stdout.write("[clock-shift] offsetMs=" + offsetMs + String.fromCharCode(10));
}, 10);
timer.unref();
`;

describe("gateway multi-instance e2e", () => {
  const instances: GatewayInstance[] = [];
  const nodeClients: GatewayClient[] = [];

  afterAll(async () => {
    await Promise.allSettled(nodeClients.map((client) => client.stopAndWait({ timeoutMs: 1_000 })));
    for (const inst of instances) {
      await stopGatewayInstance(inst);
    }
  });

  it(
    "spins up two gateways and exercises WS + HTTP + node pairing",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const [gwA, gwB] = await Promise.all([spawnGatewayInstance("a"), spawnGatewayInstance("b")]);
      instances.push(gwA, gwB);

      const [hookResA, hookResB] = await Promise.all([
        postJson(
          `http://127.0.0.1:${gwA.port}/hooks/wake`,
          {
            text: "wake a",
            mode: "now",
          },
          { "x-openclaw-token": gwA.hookToken },
        ),
        postJson(
          `http://127.0.0.1:${gwB.port}/hooks/wake`,
          {
            text: "wake b",
            mode: "now",
          },
          { "x-openclaw-token": gwB.hookToken },
        ),
      ]);
      expect(hookResA.status).toBe(200);
      expect((hookResA.json as { ok?: boolean } | undefined)?.ok).toBe(true);
      expect(hookResB.status).toBe(200);
      expect((hookResB.json as { ok?: boolean } | undefined)?.ok).toBe(true);

      const [nodeA, nodeB] = await Promise.all([
        connectNode(gwA, "node-a"),
        connectNode(gwB, "node-b"),
      ]);
      nodeClients.push(nodeA.client, nodeB.client);

      await Promise.all([
        waitForNodeStatus(gwA, nodeA.nodeId),
        waitForNodeStatus(gwB, nodeB.nodeId),
      ]);
    },
  );

  it.runIf(process.platform === "linux")(
    "preserves scheduler runtime across a scheduler-disabled Gateway edit",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const scheduler = await createOpenClawTestInstance({
        name: "cron-scheduler-owner",
        config: { cron: { enabled: true }, plugins: { enabled: false } },
        env: { OPENCLAW_SKIP_CRON: "0" },
      });
      let manager: GatewayInstance | undefined;
      let schedulerClient: GatewayClient | undefined;
      let managerClient: GatewayClient | undefined;
      try {
        await scheduler.startGateway();
        schedulerClient = await connectGatewayStatusClient(scheduler);
        const canary = await schedulerClient.request<{ id: string }>("cron.add", {
          name: "shared-store canary",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "run canary", toolsAllow: [] },
          delivery: { mode: "none" },
        });
        const target = await schedulerClient.request<{ id: string }>("cron.add", {
          name: "shared-store edit target",
          enabled: true,
          schedule: { kind: "cron", expr: "0 6 * * *" },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "edit target" },
        });

        manager = await createOpenClawTestInstance({
          name: "cron-passive-manager",
          config: { cron: { enabled: false }, plugins: { enabled: false } },
          env: {
            OPENCLAW_SKIP_CRON: "0",
            OPENCLAW_STATE_DIR: scheduler.stateDir,
          },
          gatewayCommandPrefix: [
            "/usr/bin/unshare",
            "-Ur",
            "-m",
            "--",
            "/bin/sh",
            "-c",
            '/usr/bin/mount -t tmpfs tmpfs /tmp && exec "$@"',
            "openclaw-gateway-namespace",
            "node",
          ],
        });
        await manager.startGateway();
        managerClient = await connectGatewayStatusClient(manager);
        await managerClient.request("cron.list", { includeDisabled: true });

        await schedulerClient.request("cron.run", { id: canary.id, mode: "force" });
        await expect
          .poll(
            async () => {
              const job = await schedulerClient?.request<{ state?: { lastRunAtMs?: number } }>(
                "cron.get",
                { id: canary.id },
              );
              return job?.state?.lastRunAtMs;
            },
            { timeout: 15_000, interval: 50 },
          )
          .toEqual(expect.any(Number));
        const before = await schedulerClient.request<{ state: unknown }>("cron.get", {
          id: canary.id,
        });

        await managerClient.request("cron.update", {
          id: target.id,
          patch: { description: "updated through passive Gateway" },
        });
        const after = await managerClient.request<{ state: unknown }>("cron.get", {
          id: canary.id,
        });
        expect(after.state).toEqual(before.state);
      } finally {
        schedulerClient?.stop();
        managerClient?.stop();
        await manager?.cleanup();
        await scheduler.cleanup();
      }
    },
  );

  it(
    "keeps a real node.invoke timeout stable across a gateway wall-clock change",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const proofRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-node-invoke-proof-"));
      const shiftPath = path.join(proofRoot, "shift");
      const shiftReadyPath = path.join(proofRoot, "shift-ready");
      const preloadPath = path.join(proofRoot, "clock-shift.mjs");
      let node: GatewayClient | undefined;
      let operator: GatewayClient | undefined;
      let instance: GatewayInstance | undefined;
      try {
        await writeFile(preloadPath, CLOCK_SHIFT_PRELOAD, "utf8");
        instance = await spawnGatewayInstanceWithEnv("node-invoke-clock", {
          NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
          OPENCLAW_CLOCK_SHIFT_PATH: shiftPath,
          OPENCLAW_CLOCK_SHIFT_READY_PATH: shiftReadyPath,
          OPENCLAW_CLOCK_SHIFT_MS: "1000",
        });
        const nodeIdentity = loadOrCreateDeviceIdentity({
          path: path.join(instance.homeDir, "proof-node-device.sqlite"),
        });
        let nodeClient: GatewayClient | undefined;
        node = await connectGatewayClient({
          url: instance.url,
          token: instance.gatewayToken,
          clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
          clientDisplayName: "real-node-proof",
          clientVersion: "1.0.0",
          platform: "ios",
          mode: GATEWAY_CLIENT_MODES.NODE,
          role: "node",
          scopes: [],
          caps: ["system"],
          commands: ["system.notify"],
          deviceIdentity: nodeIdentity,
          onEvent: async (event) => {
            if (event.event !== "node.invoke.request") {
              return;
            }
            const payload = event.payload as { id: string; nodeId: string };
            await writeFile(shiftPath, "shift\n");
            await waitForFile(shiftReadyPath);
            setTimeout(() => {
              void nodeClient?.request("node.invoke.result", {
                id: payload.id,
                nodeId: payload.nodeId,
                ok: true,
                payloadJSON: JSON.stringify({ captured: true }),
              });
            }, 50).unref();
          },
        });
        nodeClient = node;
        operator = await connectGatewayClient({
          url: instance.url,
          token: instance.gatewayToken,
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: path.join(instance.homeDir, "proof-operator-device.sqlite"),
          }),
        });
        await approveNodePairingForProof(operator, nodeIdentity.deviceId);
        await waitForNodeStatus(instance, nodeIdentity.deviceId);
        const startedAt = performance.now();
        const result = await operator.request<{ payload?: { captured?: boolean } }>(
          "node.invoke",
          {
            nodeId: nodeIdentity.deviceId,
            command: "system.notify",
            params: { quality: "low" },
            timeoutMs: 500,
            idempotencyKey: "real-node-invoke-clock-proof",
          },
          { timeoutMs: 5_000 },
        );
        const elapsedMs = Math.round(performance.now() - startedAt);
        expect(result.payload?.captured).toBe(true);
        expect(elapsedMs).toBeGreaterThanOrEqual(50);
        expect(elapsedMs).toBeLessThan(1_000);
        expect(instance.logs()).toContain("[clock-shift] offsetMs=1000");
        console.log(
          `[real-gateway-node-proof] gatewayProcess=true nodeWebSocket=true wallClockOffsetMs=1000 result=SUCCESS elapsedMs=${elapsedMs}`,
        );
      } finally {
        await Promise.allSettled([
          operator?.stopAndWait({ timeoutMs: 1_000 }),
          node?.stopAndWait({ timeoutMs: 1_000 }),
        ]);
        await Promise.allSettled([instance?.stopGateway()]);
        await rm(proofRoot, { recursive: true, force: true });
      }
    },
  );
});

async function spawnGatewayInstanceWithEnv(
  name: string,
  env: Record<string, string>,
): Promise<GatewayInstance> {
  const instance = await createOpenClawTestInstance({ name, env });
  try {
    await instance.startGateway();
    return instance;
  } catch (error) {
    await instance.cleanup();
    throw error;
  }
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function approveNodePairingForProof(operator: GatewayClient, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const pairing = await operator.request<{
        pending?: Array<{ nodeId?: string; requestId?: string; commands?: string[] }>;
      }>("node.pair.list", {});
      const pending = pairing.pending?.find((entry) => entry.nodeId === nodeId);
      expect(pending?.commands).toEqual(["system.notify"]);
      expect(pending?.requestId).toEqual(expect.any(String));
      await operator.request("node.pair.approve", { requestId: pending?.requestId });
    },
    { timeout: 15_000, interval: 100 },
  );
}

// Gateway multi E2E tests validate multi-gateway runtime behavior.
import { afterAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../src/gateway/client.js";
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

describe("gateway multi-instance e2e", () => {
  const instances: GatewayInstance[] = [];
  const nodeClients: GatewayClient[] = [];

  afterAll(async () => {
    for (const client of nodeClients) {
      client.stop();
    }
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
});

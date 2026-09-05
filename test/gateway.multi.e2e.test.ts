// Gateway multi E2E tests validate multi-gateway runtime behavior.
import { spawnSync } from "node:child_process";
import path from "node:path";
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
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const E2E_TIMEOUT_MS = 120_000;

async function settleGatewayCleanups(cleanups: Array<() => unknown>) {
  const results = await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multi-Gateway cleanup failed");
  }
}

async function cleanupGateways(instances: GatewayInstance[], clients: GatewayClient[]) {
  // A failed client join must not strand Gateway processes or release files
  // their owners may still use. Keep terminal cleanup with the instance owner.
  let clientsJoined = false;
  await runQaGatewayFixture(
    async () => {
      await settleGatewayCleanups(clients.map((client) => () => client.stopAndWait()));
      clientsJoined = true;
    },
    () =>
      settleGatewayCleanups(
        instances.map(
          (instance) => () =>
            clientsJoined ? stopGatewayInstance(instance) : instance.stopGateway(),
        ),
      ),
  );
}

describe("gateway multi-instance e2e", () => {
  const instances: GatewayInstance[] = [];
  const nodeClients: GatewayClient[] = [];
  const acquisitions: Promise<unknown>[] = [];

  afterAll(async () => {
    // Promise.all can reject while its siblings still acquire owners. Join the
    // original acquisitions before reading either retained cleanup collection.
    await Promise.allSettled(acquisitions);
    await cleanupGateways(instances, nodeClients);
  });

  it(
    "spins up two gateways and exercises WS + HTTP + node pairing",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const spawnOwnedGateway = async (name: string) => {
        const inst = await spawnGatewayInstance(name);
        instances.push(inst);
        return inst;
      };
      const gatewayAcquisitions = [spawnOwnedGateway("a"), spawnOwnedGateway("b")] as const;
      acquisitions.push(...gatewayAcquisitions);
      const [gwA, gwB] = await Promise.all(gatewayAcquisitions);

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

      const connectOwnedNode = async (inst: GatewayInstance, label: string) => {
        const node = await connectNode(inst, label);
        nodeClients.push(node.client);
        return node;
      };
      const nodeAcquisitions = [
        connectOwnedNode(gwA, "node-a"),
        connectOwnedNode(gwB, "node-b"),
      ] as const;
      acquisitions.push(...nodeAcquisitions);
      const [nodeA, nodeB] = await Promise.all(nodeAcquisitions);

      await Promise.all([
        waitForNodeStatus(gwA, nodeA.nodeId),
        waitForNodeStatus(gwB, nodeB.nodeId),
      ]);
    },
  );

  it(
    "preserves scheduler runtime across a scheduler-disabled Gateway edit",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const manager = await createOpenClawTestInstance({
        name: "cron-passive-manager",
        config: { cron: { enabled: false }, plugins: { enabled: false } },
        env: { OPENCLAW_SKIP_CRON: "0" },
      });
      let managerClient: GatewayClient | undefined;
      await runQaGatewayFixture(
        async () => {
          await manager.startGateway();
          managerClient = await connectGatewayStatusClient(manager);
          const canary = await managerClient.request<{ id: string }>("cron.add", {
            name: "shared-store canary",
            enabled: true,
            schedule: { kind: "every", everyMs: 3_600_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "run canary", toolsAllow: [] },
            delivery: { mode: "none" },
          });
          const target = await managerClient.request<{ id: string }>("cron.add", {
            name: "shared-store edit target",
            enabled: true,
            schedule: { kind: "cron", expr: "0 6 * * *" },
            sessionTarget: "main",
            wakeMode: "now",
            payload: { kind: "systemEvent", text: "edit target" },
          });

          await managerClient.request("cron.list", { includeDisabled: true });

          // A separate scheduler process advances the row while the passive Gateway
          // retains its snapshot. Two Gateways must not share a state directory.
          const scheduler = spawnSync(
            process.execPath,
            [
              "--import",
              path.join(process.cwd(), "scripts/tsx.mjs"),
              "--input-type=module",
              "--eval",
              `
import { CronService } from "./src/cron/service.ts";
import { resolveCronJobsStorePath } from "./src/cron/store.ts";
import { toPublicCronJob } from "./src/cron/public-job.ts";
const cron = new CronService({
  cronEnabled: true,
  storePath: resolveCronJobsStorePath(),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  enqueueSystemEvent() {},
  requestHeartbeat() {},
  async runIsolatedAgentJob() { return { status: "ok", summary: "scheduler canary completed" }; },
});
try {
  await cron.start();
  const result = await cron.run(process.argv[1], "force");
  if (!result.ok || !("ran" in result) || !result.ran) throw new Error(JSON.stringify(result));
  console.log(JSON.stringify(toPublicCronJob(cron.getJob(process.argv[1]))));
} finally {
  cron.stop();
}
`,
              canary.id,
            ],
            { cwd: process.cwd(), env: manager.env, encoding: "utf8", timeout: 60_000 },
          );
          expect(scheduler.stderr).toBe("");
          expect(scheduler.status).toBe(0);
          const before = JSON.parse(scheduler.stdout) as {
            state: { lastRunAtMs?: number; lastStatus?: string };
          };
          expect(before.state.lastRunAtMs).toEqual(expect.any(Number));
          expect(before.state.lastStatus).toBe("ok");

          await managerClient.request("cron.update", {
            id: target.id,
            patch: { description: "updated through passive Gateway" },
          });
          const after = await managerClient.request<{ state: unknown }>("cron.get", {
            id: canary.id,
          });
          expect(after.state).toEqual(before.state);
        },
        () => cleanupGateways([manager], managerClient ? [managerClient] : []),
      );
    },
  );
});

import { afterAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../src/gateway/client.js";
import {
  type GatewayInstance,
  connectNode,
  postJson,
  spawnGatewayInstance,
  stopGatewayInstance,
  waitForNodeStatus,
} from "./helpers/gateway-e2e-harness.js";

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
});

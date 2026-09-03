// Gateway multi E2E tests validate multi-gateway runtime behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { afterAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../src/gateway/client.js";
import { buildDeviceAuthPayloadV3 } from "../src/gateway/device-auth.js";
import { connectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../src/infra/device-identity.js";
import { rawDataToString } from "../src/infra/ws.js";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/index.js";
import {
  type GatewayInstance,
  connectNode,
  connectGatewayStatusClient,
  connectGatewayClient,
  postJson,
  spawnGatewayInstance,
  stopGatewayInstance,
  waitForNodeStatus,
} from "./helpers/gateway-e2e-harness.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";

const E2E_TIMEOUT_MS = 120_000;

const CLOCK_SHIFT_PRELOAD = `
import { existsSync } from "node:fs";

const shiftPath = process.env.OPENCLAW_CLOCK_SHIFT_PATH;
const offsetMs = Number(process.env.OPENCLAW_CLOCK_SHIFT_MS ?? "0");
const originalNow = Date.now.bind(Date);
const timer = setInterval(() => {
  if (!shiftPath || !existsSync(shiftPath)) {
    return;
  }
  clearInterval(timer);
  Date.now = () => originalNow() + offsetMs;
  process.stdout.write("[clock-shift] offsetMs=" + offsetMs + String.fromCharCode(10));
}, 10);
timer.unref();
`;

async function connectRawNode(params: {
  url: string;
  token: string;
  deviceIdentityPath: string;
  onInvoke: (payload: Record<string, unknown>) => void;
}) {
  const ws = new WebSocket(params.url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const challenge = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("node challenge timeout")), 5_000);
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(rawDataToString(data)) as {
        event?: string;
        payload?: { nonce?: unknown };
      };
      if (frame.event !== "connect.challenge" || typeof frame.payload?.nonce !== "string") {
        return;
      }
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(frame.payload.nonce);
    };
    ws.on("message", onMessage);
    ws.once("close", () => reject(new Error("node closed during challenge")));
  });

  const identity = loadOrCreateDeviceIdentity({ path: params.deviceIdentityPath });
  const signedAtMs = Date.now();
  const clientId = GATEWAY_CLIENT_NAMES.NODE_HOST;
  const clientMode = GATEWAY_CLIENT_MODES.NODE;
  const device = {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(
      identity.privateKeyPem,
      buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId,
        clientMode,
        role: "node",
        scopes: [],
        signedAtMs,
        token: params.token,
        nonce: challenge,
        platform: "ios",
      }),
    ),
    signedAt: signedAtMs,
    nonce: challenge,
  };
  ws.send(
    JSON.stringify({
      type: "req",
      id: "node-connect",
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: clientId,
          displayName: "real-node-proof",
          version: "1.0.0",
          platform: "ios",
          mode: clientMode,
        },
        caps: ["system"],
        commands: ["camera.capture"],
        auth: { token: params.token },
        role: "node",
        scopes: [],
        device,
      },
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("node connect response timeout")), 5_000);
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(rawDataToString(data)) as {
        type?: string;
        id?: string;
        ok?: boolean;
        error?: { message?: string };
      };
      if (frame.type !== "res" || frame.id !== "node-connect") {
        return;
      }
      clearTimeout(timer);
      ws.off("message", onMessage);
      if (!frame.ok) {
        reject(new Error(frame.error?.message ?? "node connect failed"));
        return;
      }
      resolve();
    };
    ws.on("message", onMessage);
    ws.once("close", () => reject(new Error("node closed during connect")));
  });
  ws.on("message", (data) => {
    const frame = JSON.parse(rawDataToString(data)) as {
      event?: string;
      payload?: Record<string, unknown>;
    };
    if (frame.event === "node.invoke.request" && frame.payload) {
      params.onInvoke(frame.payload);
    }
  });
  return { deviceId: identity.deviceId, ws };
}

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

  it(
    "keeps a real node.invoke timeout stable across a gateway wall-clock change",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const proofRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-node-invoke-proof-"));
      const shiftPath = path.join(proofRoot, "shift");
      const preloadPath = path.join(proofRoot, "clock-shift.mjs");
      await writeFile(preloadPath, CLOCK_SHIFT_PRELOAD, "utf8");
      const instance = await spawnGatewayInstanceWithEnv("node-invoke-clock", {
        NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
        OPENCLAW_CLOCK_SHIFT_PATH: shiftPath,
        OPENCLAW_CLOCK_SHIFT_MS: "-10000",
      });
      instances.push(instance);
      let nodeSocket: WebSocket | undefined;
      const node = await connectRawNode({
        url: instance.url,
        token: instance.gatewayToken,
        deviceIdentityPath: path.join(instance.homeDir, "proof-node-device.sqlite"),
        onInvoke: (payload) => {
          void writeFile(shiftPath, "shift\n");
          setTimeout(() => {
            nodeSocket?.send(
              JSON.stringify({
                type: "req",
                id: `late-${String(payload.id)}`,
                method: "node.invoke.result",
                params: {
                  id: payload.id,
                  nodeId: payload.nodeId,
                  ok: true,
                  payload: { late: true },
                },
              }),
            );
          }, 1_200).unref();
        },
      });
      nodeSocket = node.ws;
      const operator = await connectGatewayClient({
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
      try {
        await waitForNodeStatus(instance, node.deviceId);
        const startedAt = performance.now();
        let error: unknown;
        try {
          await operator.request(
            "node.invoke",
            {
              nodeId: node.deviceId,
              command: "camera.capture",
              params: { quality: "low" },
              timeoutMs: 500,
              idempotencyKey: "real-node-invoke-clock-proof",
            },
            { timeoutMs: 5_000 },
          );
        } catch (caught) {
          error = caught;
        }
        const elapsedMs = Math.round(performance.now() - startedAt);
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("TIMEOUT");
        expect(elapsedMs).toBeGreaterThanOrEqual(400);
        expect(elapsedMs).toBeLessThan(1_500);
        expect(instance.logs()).toContain("[clock-shift] offsetMs=-10000");
        console.log(
          `[real-gateway-node-proof] gatewayProcess=true nodeWebSocket=true wallClockOffsetMs=-10000 result=TIMEOUT elapsedMs=${elapsedMs}`,
        );
      } finally {
        operator.stop();
        node.ws.close();
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

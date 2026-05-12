import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RawData, WebSocketServer } from "ws";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { connectTestGatewayClient } from "./gateway-cli-backend.live-helpers.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";

const GATEWAY_CONNECT_TIMEOUT_MS = 5_000;
const tempRoots: string[] = [];

async function createTempDeviceIdentity() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-connect-"));
  tempRoots.push(tempRoot);
  return loadOrCreateDeviceIdentity(path.join(tempRoot, "device.json"));
}

async function startMinimalGatewayServer(params: { token: string }) {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const requests: string[] = [];

  wss.on("connection", (ws) => {
    ws.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "test-nonce" },
      }),
    );
    ws.on("message", (data) => {
      const frame = JSON.parse(rawWsDataToString(data)) as {
        type?: string;
        id?: string;
        method?: string;
        params?: { auth?: { token?: string }; device?: { nonce?: string } };
      };
      if (frame.type !== "req" || !frame.id) {
        return;
      }
      requests.push(frame.method ?? "");
      if (frame.method === "connect") {
        expect(frame.params?.auth?.token).toBe(params.token);
        expect(frame.params?.device?.nonce).toBe("test-nonce");
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: PROTOCOL_VERSION,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["health"], events: ["connect.challenge"] },
              snapshot: {
                presence: [],
                health: { ok: true },
                stateVersion: { presence: 0, health: 0 },
                uptimeMs: 0,
              },
              policy: {
                maxPayload: 1,
                maxBufferedBytes: 1,
                tickIntervalMs: 60_000,
              },
            },
          }),
        );
        return;
      }
      if (frame.method === "health") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  return {
    requests,
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function rawWsDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

describe("gateway cli backend connect", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it(
    "connects a test gateway client through the live helper",
    async () => {
      const token = `test-${Date.now()}`;
      const deviceIdentity = await createTempDeviceIdentity();
      const server = await startMinimalGatewayServer({ token });
      let client: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;

      try {
        client = await connectTestGatewayClient({
          url: server.url,
          token,
          deviceIdentity,
          timeoutMs: 1_000,
          maxAttemptTimeoutMs: 1_000,
          requestTimeoutMs: 1_000,
        });
        const health = await client.request("health", undefined, {
          timeoutMs: 1_000,
        });
        expect(health.ok).toBe(true);
        expect(server.requests).toEqual(["connect", "health"]);
      } finally {
        await client?.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
        await server.close();
      }
    },
    GATEWAY_CONNECT_TIMEOUT_MS,
  );
});

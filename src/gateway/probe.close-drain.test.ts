import fs from "node:fs/promises";
import { type AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RawData, WebSocketServer } from "ws";
import { probeGateway } from "./probe.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";

const tempRoots: string[] = [];

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

function activeClientSocketsToPort(port: number): Socket[] {
  // Node has no public active-handle API; this regression must prove the probe
  // promise does not resolve while the client-side socket handle is still live.
  // oxlint-disable no-underscore-dangle
  const handles =
    (process as typeof process & { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ??
    [];
  // oxlint-enable no-underscore-dangle
  return handles.filter(
    (handle): handle is Socket => handle instanceof Socket && handle.remotePort === port,
  );
}

async function createTempStateDir(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "openclaw-probe-close-drain-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

describe("probeGateway close drain", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("waits for the real WebSocket client socket to close before resolving", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let sawConnect = false;

    wss.on("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "test-nonce" },
        }),
      );
      ws.on("message", (raw) => {
        const frame = JSON.parse(rawWsDataToString(raw)) as {
          id?: string;
          method?: string;
          type?: string;
        };
        if (frame.type !== "req" || frame.method !== "connect" || !frame.id) {
          return;
        }
        sawConnect = true;
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: PROTOCOL_VERSION,
              server: { version: "test", connId: "conn-test" },
              features: { methods: [], events: ["connect.challenge"] },
              snapshot: {},
              auth: { role: "operator", scopes: ["operator.read"] },
              policy: {
                maxPayload: 1_000_000,
                maxBufferedBytes: 1_000_000,
                tickIntervalMs: 60_000,
              },
            },
          }),
        );
      });
    });

    try {
      await new Promise<void>((resolve) => wss.once("listening", resolve));
      const port = (wss.address() as AddressInfo).port;

      const result = await probeGateway({
        url: `ws://127.0.0.1:${port}`,
        auth: { token: "secret" },
        timeoutMs: 1_000,
        includeDetails: false,
        env: { ...process.env, OPENCLAW_STATE_DIR: await createTempStateDir() },
      });

      expect(result.ok).toBe(true);
      expect(sawConnect).toBe(true);
      expect(activeClientSocketsToPort(port)).toHaveLength(0);
    } finally {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

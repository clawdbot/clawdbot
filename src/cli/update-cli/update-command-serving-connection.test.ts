import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { rawDataToString } from "../../infra/ws.js";
import * as probe from "../daemon-cli/restart-health-probe.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { withUpdateCommandServingConnection } from "./update-command-serving-connection.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
it.each([
  "success",
  "auth-none",
  "remote-auth-none",
  "close",
  "shutdown",
  "gap",
  "first-gap",
  "wrong-boot",
  "auth-denied",
  "revoke",
])("retains only the live authenticated serving boot (%s)", async (mode) => {
  const root = fs.realpathSync(dirs.make("serving-connection-"));
  const control = path.join(root, "control");
  fs.mkdirSync(control);
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  vi.spyOn(probe, "resolveGatewayRestartProbeContext").mockResolvedValue({
    config: {
      gateway: {
        mode: mode === "remote-auth-none" ? "remote" : "local",
        auth: { mode: mode.includes("auth-none") ? "none" : "token" },
      },
    },
    auth: mode.includes("auth-none") ? undefined : { token: "fixture-only-token" },
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test port");
  }
  let peer: WebSocket | undefined;
  let connections = 0;
  const methods: string[] = [];
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.on("connection", (socket) => {
    peer = socket;
    connections += 1;
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: randomUUID(), ts: Date.now() },
      }),
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as {
        id: string;
        method: string;
        params?: unknown;
      };
      methods.push(frame.method);
      requests.push(frame);
      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: mode !== "auth-denied",
            ...(mode === "auth-denied"
              ? { error: { code: "UNAVAILABLE", message: "unauthorized" } }
              : {
                  payload: {
                    type: "hello-ok",
                    protocol: 4,
                    server: {
                      version: "1.0.0",
                      bootId: mode === "wrong-boot" ? "foreign" : "fixture-boot",
                      connId: "fixture-connection",
                    },
                    features: { methods: ["health"], events: ["shutdown", "tick"] },
                    snapshot: {
                      presence: [],
                      health: {},
                      stateVersion: { presence: 1, health: 1 },
                      uptimeMs: 1,
                    },
                    auth: { role: "operator", scopes: ["operator.read"] },
                    policy: {
                      maxPayload: 524288,
                      maxBufferedBytes: 1048576,
                      tickIntervalMs: 30000,
                    },
                  },
                }),
          }),
        );
      } else if (frame.method === "health") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
      }
    });
  });
  let escaped: (() => void) | undefined;
  const operation = vi.fn(async (assertCurrent: () => void) => {
    escaped = assertCurrent;
    assertCurrent();
    if (mode === "revoke") {
      const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
      try {
        db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
          "replacement",
          root,
        );
      } finally {
        db.close();
      }
      expect(assertCurrent).toThrow(/executor|ownership/i);
    } else if (["close", "shutdown", "gap", "first-gap"].includes(mode)) {
      if (mode === "close") {
        peer!.close();
      } else {
        if (mode === "gap") {
          peer!.send(JSON.stringify({ type: "event", event: "tick", seq: 1, payload: {} }));
        }
        peer!.send(
          JSON.stringify({
            type: "event",
            event: mode === "shutdown" ? "shutdown" : "tick",
            seq: mode === "gap" ? 10 : mode === "first-gap" ? 2 : 1,
            payload: {},
          }),
        );
      }
      await vi.waitFor(() => expect(assertCurrent).toThrow(/serving/i));
    }
    return "completed";
  });
  try {
    const run = withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      return await withUpdateCommandServingConnection(
        {
          env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
          port: address.port,
          gateway: { version: "1.0.0", buildId: null, bootId: "fixture-boot" },
          assertCurrent: () => fence.assertCurrent(),
        },
        operation,
      );
    });
    if (mode === "success" || mode === "auth-none") {
      await expect(run).resolves.toBe("completed");
    } else {
      await expect(run).rejects.toThrow(/serving|executor|ownership/i);
    }
    if (mode === "remote-auth-none") {
      expect(connections).toBe(0);
      expect(operation).not.toHaveBeenCalled();
      return;
    }
    expect(connections).toBe(1);
    expect(requests[0]).toMatchObject({
      method: "connect",
      params: {
        ...(mode === "auth-none" ? {} : { auth: { token: "fixture-only-token" } }),
        scopes: ["operator.read"],
        client: {
          id: mode === "auth-none" ? "gateway-client" : "cli",
          mode: mode === "auth-none" ? "backend" : "cli",
        },
      },
    });
    if (mode === "auth-none") {
      expect(requests[0]?.params).not.toHaveProperty("device");
      expect(requests[0]?.params).not.toHaveProperty("auth");
    }
    if (["wrong-boot", "auth-denied"].includes(mode)) {
      expect(operation).not.toHaveBeenCalled();
      expect(methods).toEqual(["connect"]);
    } else {
      expect(operation).toHaveBeenCalledOnce();
      expect(methods).toEqual(["connect", "health"]);
      expect(escaped).toThrow();
    }
    expect(fs.existsSync(path.join(root, "state"))).toBe(false);
  } finally {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

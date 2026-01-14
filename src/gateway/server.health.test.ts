import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { emitAgentEvent } from "../infra/agent-events.js";
import { emitHeartbeatEvent } from "../infra/heartbeat-events.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  startGatewayServer,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway server health/presence", () => {
  test(
    "connect + health + presence + status succeed",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const healthP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "health1",
      );
      const statusP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "status1",
      );
      const presenceP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "presence1",
      );
      const channelsP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "channels1",
      );

      const sendReq = (id: string, method: string) =>
        ws.send(JSON.stringify({ type: "req", id, method }));
      sendReq("health1", "health");
      sendReq("status1", "status");
      sendReq("presence1", "system-presence");
      sendReq("channels1", "channels.status");

      const health = await healthP;
      const status = await statusP;
      const presence = await presenceP;
      const channels = await channelsP;
      expect(health.ok).toBe(true);
      expect(status.ok).toBe(true);
      expect(presence.ok).toBe(true);
      expect(channels.ok).toBe(true);
      expect(Array.isArray(presence.payload)).toBe(true);

      ws.close();
      await server.close();
    },
  );

  test("broadcasts heartbeat events and serves last-heartbeat", async () => {
    type HeartbeatPayload = {
      ts: number;
      status: string;
      to?: string;
      preview?: string;
      durationMs?: number;
      hasMedia?: boolean;
      reason?: string;
    };
    type EventFrame = {
      type: "event";
      event: string;
      payload?: HeartbeatPayload | null;
    };
    type ResFrame = {
      type: "res";
      id: string;
      ok: boolean;
      payload?: unknown;
    };

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const waitHeartbeat = onceMessage<EventFrame>(
      ws,
      (o) => o.type === "event" && o.event === "heartbeat",
    );
    emitHeartbeatEvent({ status: "sent", to: "+123", preview: "ping" });
    const evt = await waitHeartbeat;
    expect(evt.payload?.status).toBe("sent");
    expect(typeof evt.payload?.ts).toBe("number");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "hb-last",
        method: "last-heartbeat",
      }),
    );
    const last = await onceMessage<ResFrame>(
      ws,
      (o) => o.type === "res" && o.id === "hb-last",
    );
    expect(last.ok).toBe(true);
    const lastPayload = last.payload as HeartbeatPayload | null | undefined;
    expect(lastPayload?.status).toBe("sent");
    expect(lastPayload?.ts).toBe(evt.payload?.ts);

    ws.send(
      JSON.stringify({
        type: "req",
        id: "hb-toggle-off",
        method: "set-heartbeats",
        params: { enabled: false },
      }),
    );
    const toggle = await onceMessage<ResFrame>(
      ws,
      (o) => o.type === "res" && o.id === "hb-toggle-off",
    );
    expect(toggle.ok).toBe(true);
    expect((toggle.payload as { enabled?: boolean } | undefined)?.enabled).toBe(
      false,
    );

    ws.close();
    await server.close();
  });

  test(
    "presence events carry seq + stateVersion",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const presenceEventP = onceMessage(
        ws,
        (o) => o.type === "event" && o.event === "presence",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "evt-1",
          method: "system-event",
          params: { text: "note from test" },
        }),
      );

      const evt = await presenceEventP;
      expect(typeof evt.seq).toBe("number");
      expect(evt.stateVersion?.presence).toBeGreaterThan(0);
      expect(Array.isArray(evt.payload?.presence)).toBe(true);

      ws.close();
      await server.close();
    },
  );

  test("agent events stream with seq", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const runId = randomUUID();
    const evtPromise = onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "agent" &&
        o.payload?.runId === runId &&
        o.payload?.stream === "lifecycle",
    );
    emitAgentEvent({ runId, stream: "lifecycle", data: { msg: "hi" } });
    const evt = await evtPromise;
    expect(evt.payload.runId).toBe(runId);
    expect(typeof evt.seq).toBe("number");
    expect(evt.payload.data.msg).toBe("hi");

    ws.close();
    await server.close();
  });

  test("shutdown event is broadcast on close", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const shutdownP = onceMessage(
      ws,
      (o) => o.type === "event" && o.event === "shutdown",
      5000,
    );
    await server.close();
    const evt = await shutdownP;
    expect(evt.payload?.reason).toBeDefined();
  });

  test(
    "presence broadcast reaches multiple clients",
    { timeout: 8000 },
    async () => {
      const port = await getFreePort();
      const server = await startGatewayServer(port);
      const mkClient = async () => {
        const c = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((resolve) => c.once("open", resolve));
        await connectOk(c);
        return c;
      };

      const clients = await Promise.all([mkClient(), mkClient(), mkClient()]);
      const waits = clients.map((c) =>
        onceMessage(c, (o) => o.type === "event" && o.event === "presence"),
      );
      clients[0].send(
        JSON.stringify({
          type: "req",
          id: "broadcast",
          method: "system-event",
          params: { text: "fanout" },
        }),
      );
      const events = await Promise.all(waits);
      for (const evt of events) {
        expect(evt.payload?.presence?.length).toBeGreaterThan(0);
        expect(typeof evt.seq).toBe("number");
      }
      for (const c of clients) c.close();
      await server.close();
    },
  );

  test("presence includes client fingerprint", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_NAMES.FINGERPRINT,
        version: "9.9.9",
        platform: "test",
        deviceFamily: "iPad",
        modelIdentifier: "iPad16,6",
        mode: GATEWAY_CLIENT_MODES.UI,
        instanceId: "abc",
      },
    });

    const presenceP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "fingerprint",
      4000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "fingerprint",
        method: "system-presence",
      }),
    );

    const presenceRes = await presenceP;
    const entries = presenceRes.payload as Array<Record<string, unknown>>;
    const clientEntry = entries.find((e) => e.instanceId === "abc");
    expect(clientEntry?.host).toBe(GATEWAY_CLIENT_NAMES.FINGERPRINT);
    expect(clientEntry?.version).toBe("9.9.9");
    expect(clientEntry?.mode).toBe("ui");
    expect(clientEntry?.deviceFamily).toBe("iPad");
    expect(clientEntry?.modelIdentifier).toBe("iPad16,6");

    ws.close();
    await server.close();
  });

  test("cli connections are not tracked as instances", async () => {
    const { server, ws } = await startServerWithClient();
    const cliId = `cli-${randomUUID()}`;
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_NAMES.CLI,
        version: "dev",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.CLI,
        instanceId: cliId,
      },
    });

    const presenceP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "cli-presence",
      4000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "cli-presence",
        method: "system-presence",
      }),
    );

    const presenceRes = await presenceP;
    const entries = presenceRes.payload as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.instanceId === cliId)).toBe(false);

    ws.close();
    await server.close();
  });
});

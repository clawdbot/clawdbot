import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { emitHeartbeatEvent } from "../infra/heartbeat-events.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks, onceMessage } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const HEALTH_E2E_TIMEOUT_MS = 20_000;
const PRESENCE_EVENT_TIMEOUT_MS = 6_000;
const SHUTDOWN_EVENT_TIMEOUT_MS = 3_000;
const FINGERPRINT_TIMEOUT_MS = 3_000;
const CLI_PRESENCE_TIMEOUT_MS = 3_000;

let harness: GatewayServerHarness;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
});

afterAll(async () => {
  await harness.close();
});

describe("gateway server health/presence", () => {
  test(
    "connect + health + presence + status succeed",
    { timeout: HEALTH_E2E_TIMEOUT_MS },
    async () => {
      const { ws } = await harness.openClient();

      const healthP = onceMessage(ws, (o) => o.type === "res" && o.id === "health1");
      const statusP = onceMessage(ws, (o) => o.type === "res" && o.id === "status1");
      const presenceP = onceMessage(ws, (o) => o.type === "res" && o.id === "presence1");

      const sendReq = (id: string, method: string) =>
        ws.send(JSON.stringify({ type: "req", id, method }));
      sendReq("health1", "health");
      sendReq("status1", "status");
      sendReq("presence1", "system-presence");

      const health = await healthP;
      const status = await statusP;
      const presence = await presenceP;
      expect(health.ok).toBe(true);
      expect(status.ok).toBe(true);
      expect(presence.ok).toBe(true);
      expect(Array.isArray(presence.payload)).toBe(true);

      ws.close();
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

    const { ws } = await harness.openClient();

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
    const last = await onceMessage(ws, (o) => o.type === "res" && o.id === "hb-last");
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
    const toggle = await onceMessage(ws, (o) => o.type === "res" && o.id === "hb-toggle-off");
    expect(toggle.ok).toBe(true);
    expect((toggle.payload as { enabled?: boolean } | undefined)?.enabled).toBe(false);

    ws.close();
  });

  test(
    "presence events carry seq + stateVersion",
    { timeout: PRESENCE_EVENT_TIMEOUT_MS },
    async () => {
      const { ws } = await harness.openClient();

      const presenceEventP = onceMessage(ws, (o) => o.type === "event" && o.event === "presence");
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
      const evtPayload = evt.payload as { presence?: unknown } | undefined;
      expect(Array.isArray(evtPayload?.presence)).toBe(true);

      ws.close();
    },
  );

  test("agent events stream with seq", { timeout: PRESENCE_EVENT_TIMEOUT_MS }, async () => {
    const { ws } = await harness.openClient();

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
    const payload = evt.payload as Record<string, unknown> | undefined;
    expect(payload?.runId).toBe(runId);
    expect(typeof evt.seq).toBe("number");
    const data = payload?.data as Record<string, unknown> | undefined;
    expect(data?.msg).toBe("hi");

    ws.close();
  });

  test("shutdown event is broadcast on close", { timeout: PRESENCE_EVENT_TIMEOUT_MS }, async () => {
    const localHarness = await startGatewayServerHarness();
    const { ws } = await localHarness.openClient();
    const shutdownP = onceMessage(
      ws,
      (o) => o.type === "event" && o.event === "shutdown",
      SHUTDOWN_EVENT_TIMEOUT_MS,
    );
    await localHarness.close();
    const evt = await shutdownP;
    const evtPayload = evt.payload as { reason?: unknown } | undefined;
    expect(evtPayload?.reason).toBe("gateway stopping");
  });

  test(
    "presence broadcast reaches multiple clients",
    { timeout: PRESENCE_EVENT_TIMEOUT_MS },
    async () => {
      const clients = await Promise.all([
        harness.openClient(),
        harness.openClient(),
        harness.openClient(),
      ]);
      const waits = clients.map(({ ws }) =>
        onceMessage(ws, (o) => o.type === "event" && o.event === "presence"),
      );
      clients[0].ws.send(
        JSON.stringify({
          type: "req",
          id: "broadcast",
          method: "system-event",
          params: { text: "fanout" },
        }),
      );
      const events = await Promise.all(waits);
      for (const evt of events) {
        const evtPayload = evt.payload as { presence?: unknown[] } | undefined;
        expect(evtPayload?.presence?.length).toBeGreaterThan(0);
        expect(typeof evt.seq).toBe("number");
      }
      for (const { ws } of clients) {
        ws.close();
      }
    },
  );

  test("presence includes client fingerprint", async () => {
    const role = "operator";
    const scopes: string[] = ["operator.admin"];
    const { ws } = await harness.openClient({
      role,
      scopes,
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
      FINGERPRINT_TIMEOUT_MS,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "fingerprint",
        method: "system-presence",
      }),
    );

    const presenceRes = (await presenceP) as { ok?: boolean; payload?: unknown };
    expect(presenceRes.ok).toBe(true);
    const presencePayload = presenceRes.payload;
    const entries = Array.isArray(presencePayload)
      ? presencePayload
      : Array.isArray((presencePayload as { presence?: unknown } | undefined)?.presence)
        ? ((presencePayload as { presence: Array<Record<string, unknown>> }).presence ?? [])
        : [];
    const clientEntry = entries.find(
      (e) => e.host === GATEWAY_CLIENT_NAMES.FINGERPRINT && e.version === "9.9.9",
    );
    expect(clientEntry?.host).toBe(GATEWAY_CLIENT_NAMES.FINGERPRINT);
    expect(clientEntry?.version).toBe("9.9.9");
    expect(clientEntry?.mode).toBe("ui");
    expect(clientEntry?.deviceFamily).toBe("iPad");
    expect(clientEntry?.modelIdentifier).toBe("iPad16,6");

    ws.close();
  });

  test("cli connections are not tracked as instances", async () => {
    const cliId = `cli-${randomUUID()}`;
    const { ws } = await harness.openClient({
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
      CLI_PRESENCE_TIMEOUT_MS,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "cli-presence",
        method: "system-presence",
      }),
    );

    const presenceRes = await presenceP;
    const entries = (presenceRes.payload ?? []) as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry.instanceId)).not.toContain(cliId);

    ws.close();
  });
});

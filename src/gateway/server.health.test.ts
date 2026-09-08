/**
 * Gateway health endpoint integration tests.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { emitHeartbeatEvent } from "../infra/heartbeat-events.js";
import { drainSystemEvents } from "../infra/system-events.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks, onceMessage, rpcReq } from "./test-helpers.js";

// Health/presence coverage does not exercise post-restart delivery recovery.
// Keep that auto-reply graph in the dedicated restart-sentinel suite.
vi.mock("./server-restart-sentinel.js", () => ({
  recoverPendingRestartContinuationDeliveries: vi.fn(async () => undefined),
}));

const HEALTH_E2E_TIMEOUT_MS = 20_000;
const PRESENCE_EVENT_TIMEOUT_MS = 6_000;
const SHUTDOWN_EVENT_TIMEOUT_MS = 3_000;
const FINGERPRINT_TIMEOUT_MS = 3_000;
const CLI_PRESENCE_TIMEOUT_MS = 3_000;

let harness: GatewayServerHarness;
let harnessClose: Promise<void> | undefined;

installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    await writeConfigFile({
      agents: {
        defaults: {
          workspace: path.join(
            expectDefined(process.env.OPENCLAW_STATE_DIR, "gateway fixture state directory"),
            "workspace",
          ),
        },
      },
    });
    harness = await startGatewayServerHarness();
  },
  cleanup: async () => {
    await (harnessClose ?? harness?.close());
  },
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

      const presenceEventP = onceMessage<PresenceEvent>(
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
      const evtPayload = evt.payload as { presence?: unknown } | undefined;
      expect(Array.isArray(evtPayload?.presence)).toBe(true);

      const instanceId = `presence-beacon-${randomUUID()}`;
      const sessionKey = `agent:main:presence-${randomUUID()}`;
      const text =
        "Node: Relay-Host (10.0.0.9) · app 2.1.0 · last input 7s ago · mode ui · reason periodic";
      type PresenceEvent = {
        type: string;
        event?: string;
        payload?: { presence: SystemPresence[] };
        seq?: number;
        stateVersion?: { presence?: number };
      };
      let seq = expectDefined(evt.seq, "presence sequence");
      let version = expectDefined(evt.stateVersion?.presence, "presence state version");
      const beacon = async (
        overrides: { ip?: string; lastInputSeconds?: number },
        ip: string,
        lastInputSeconds: number,
      ) => {
        const eventP = onceMessage<PresenceEvent>(
          ws,
          (frame) =>
            frame.type === "event" &&
            frame.event === "presence" &&
            Boolean(
              frame.payload?.presence.some(
                (row) =>
                  row.instanceId === instanceId &&
                  row.ip === ip &&
                  row.lastInputSeconds === lastInputSeconds,
              ),
            ),
        );
        const [response, event] = await Promise.all([
          rpcReq(ws, "system-event", { text, instanceId, sessionKey, ...overrides }),
          eventP,
        ]);
        expect(response).toMatchObject({ ok: true, payload: { ok: true } });
        expect(event.seq).toBeGreaterThan(seq);
        expect(event.stateVersion?.presence).toBeGreaterThan(version);
        seq = expectDefined(event.seq, "presence sequence");
        version = expectDefined(event.stateVersion?.presence, "presence state version");
        const rows = event.payload?.presence.filter((row) => row.instanceId === instanceId);
        expect(rows).toHaveLength(1);
        expect(rows?.[0]).toMatchObject({
          host: "Relay-Host",
          ip,
          version: "2.1.0",
          lastInputSeconds,
          mode: "ui",
          reason: "periodic",
          instanceId,
          text,
          ts: expect.any(Number),
        });
      };

      try {
        await beacon({}, "10.0.0.9", 7);
        expect(drainSystemEvents(sessionKey)).toEqual([
          "Node: Relay-Host (10.0.0.9) · app 2.1.0 · mode ui",
        ]);

        // Consuming the first event clears queue dedupe; it cannot hide a noisy refresh.
        await beacon({ lastInputSeconds: 11 }, "10.0.0.9", 11);
        expect(drainSystemEvents(sessionKey)).toEqual([]);

        await beacon({ ip: "10.0.0.10", lastInputSeconds: 11 }, "10.0.0.10", 11);
        expect(drainSystemEvents(sessionKey)).toEqual(["Node: Relay-Host (10.0.0.10)"]);
      } finally {
        drainSystemEvents(sessionKey);
        ws.close();
      }
    },
  );

  test("system-event accepts exact-session routing fields", async () => {
    const { ws } = await harness.openClient();
    const responseP = onceMessage(ws, (o) => o.type === "res" && o.id === "targeted-event");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "targeted-event",
        method: "system-event",
        params: {
          text: "post-update welcome",
          sessionKey: "agent:main:main",
          wake: false,
        },
      }),
    );

    expect(await responseP).toMatchObject({ ok: true, payload: { ok: true } });
    ws.close();
  });

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

  // Close the suite owner last; another startup would reset process-wide config under live peers.
  test("shutdown event is broadcast on close", { timeout: PRESENCE_EVENT_TIMEOUT_MS }, async () => {
    const { ws } = await harness.openClient();
    const shutdownP = onceMessage(
      ws,
      (o) => o.type === "event" && o.event === "shutdown",
      SHUTDOWN_EVENT_TIMEOUT_MS,
    );
    harnessClose = harness.close();
    await harnessClose;
    const evt = await shutdownP;
    const evtPayload = evt.payload as { reason?: unknown } | undefined;
    expect(evtPayload?.reason).toBe("gateway stopping");
  });
});

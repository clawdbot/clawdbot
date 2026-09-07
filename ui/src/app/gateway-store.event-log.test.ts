// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "../api/event-log.ts";
import type { GatewayHelloOk } from "../api/gateway.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import type { ApplicationGatewayConnectOptions } from "./gateway.ts";

function hello(recoveryScope: string): GatewayHelloOk {
  return {
    ...GATEWAY_STORE_TEST_HELLO,
    auth: { role: "operator", scopes: [], recoveryScope },
  };
}

const A_EVENT = createGatewayEvent("chat", { text: "Gateway A message" });
const B_EVENT = createGatewayEvent("chat", { text: "Gateway B message" });
const B_URL = "wss://gateway-b.example.test";
const C_URL = "wss://gateway-c.example.test";

describe("application gateway diagnostic history ownership", () => {
  let store: ReturnType<typeof createGatewayStoreTestStore>;

  beforeEach(() => {
    stubGatewayStoreTestGlobals();
    store = createGatewayStoreTestStore();
    store.gateway.start();
    store.current().opts.onHello?.(hello("account-a"));
    store.current().opts.onEvent?.(A_EVENT);
  });

  afterEach(() => {
    store.gateway.stop();
    setAvatarGatewayOrigin(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["Gateway origin", { gatewayUrl: B_URL }],
    ["Gateway path", { gatewayUrl: "ws://127.0.0.1:18789/other" }],
    ["Gateway query", { gatewayUrl: "ws://127.0.0.1:18789/?target=other" }],
    ["shared token", { token: "synthetic-replacement-token" }],
    ["password", { password: "synthetic-replacement-password" }],
    ["bootstrap handoff", { bootstrapToken: "synthetic-bootstrap", bootstrapProfile: "owner" }],
  ] satisfies Array<[string, ApplicationGatewayConnectOptions]>)(
    "retires old payloads before connecting with a changed %s",
    (_name, overrides) => {
      const { gateway, current } = store;
      const oldClient = current();
      const observed = vi.fn<(events: readonly EventLogEntry[]) => void>();
      gateway.subscribeEventLog(observed);

      gateway.connect(overrides);

      expect(gateway.eventLog).toEqual([]);
      expect(observed).toHaveBeenLastCalledWith([]);
      expect(gateway.eventLogRevision).toBe(1);
      oldClient.opts.onEvent?.(A_EVENT);
      expect(gateway.eventLog).toEqual([]);

      current().opts.onClose?.({ code: 4008, reason: "rejected", willRetry: false });
      expect(gateway.eventLog).toEqual([]);
    },
  );

  it("publishes each retirement even when the raw log is already empty", () => {
    const { gateway } = store;
    const revisions: number[] = [];
    gateway.subscribeEventLog(() => revisions.push(gateway.eventLogRevision));

    gateway.connect({ gatewayUrl: B_URL });
    gateway.connect({ gatewayUrl: C_URL });

    expect(revisions).toEqual([1, 2]);
    expect(gateway.eventLog).toEqual([]);
  });

  it.each(["transport reconnect", "manual retry", "event gap", "stop/start", "session selection"])(
    "preserves same-account history through %s",
    (transition) => {
      const { gateway, current } = store;
      const history = gateway.eventLog;
      switch (transition) {
        case "transport reconnect":
          current().opts.onClose?.({ code: 1006, reason: "lost", willRetry: true });
          break;
        case "manual retry":
          gateway.connect({ ...gateway.connection });
          break;
        case "event gap":
          current().opts.onGap?.({ expected: 1, received: 3 });
          break;
        case "stop/start":
          gateway.stop();
          gateway.start();
          break;
        case "session selection":
          gateway.setSessionKey("agent:main:another");
          break;
      }
      current().opts.onHello?.(hello("account-a"));
      current().opts.onRecoveryScopeChange?.();

      expect(gateway.eventLog).toBe(history);
      expect(gateway.eventLogRevision).toBe(0);
    },
  );

  it("retires an account change at unchanged settings without requiring presence", () => {
    const { gateway, current } = store;
    const observed = vi.fn<(events: readonly EventLogEntry[]) => void>();
    gateway.subscribeEventLog(observed);
    current().opts.onClose?.({ code: 1006, reason: "lost", willRetry: true });

    current().opts.onHello?.(hello("account-b"));

    expect(gateway.snapshot.selfUser).toBeNull();
    expect(gateway.connectionRevision).toBe(0);
    expect(gateway.eventLog).toEqual([]);
    expect(gateway.eventLogRevision).toBe(1);
    expect(observed).toHaveBeenLastCalledWith([]);

    current().opts.onEvent?.(B_EVENT);
    current().opts.onHello?.(hello("account-b"));
    current().opts.onRecoveryScopeChange?.();
    expect(gateway.eventLog.map((event) => event.payload)).toEqual([B_EVENT.payload]);
    expect(gateway.eventLogRevision).toBe(1);
  });

  it("preserves authenticated history after a bootstrap handoff is consumed", () => {
    const { gateway, current } = store;
    gateway.connect({ bootstrapToken: "synthetic-bootstrap", bootstrapProfile: "owner" });
    current().opts.onHello?.(hello("account-b"));
    current().opts.onEvent?.(B_EVENT);
    const history = gateway.eventLog;

    gateway.connect();
    current().opts.onHello?.(hello("account-b"));

    expect(gateway.connection.bootstrapToken).toBe("");
    expect(gateway.eventLog).toBe(history);
    expect(gateway.eventLogRevision).toBe(1);
  });

  it.each(["replace", "stop", "record"] as const)(
    "keeps retirement current when a log subscriber %ss synchronously",
    (action) => {
      const { gateway, clients, current } = store;
      const observed: unknown[][] = [];
      let armed = true;
      gateway.subscribeEventLog((events) => {
        if (!armed || events.length > 0) {
          return;
        }
        armed = false;
        if (action === "replace") {
          gateway.connect({ gatewayUrl: C_URL });
        } else if (action === "stop") {
          gateway.stop();
        } else {
          current().opts.onEvent?.(B_EVENT);
        }
      });
      gateway.subscribeEventLog((events) => observed.push(events.map((event) => event.payload)));

      gateway.connect({ gatewayUrl: B_URL });

      expect(observed).toEqual(action === "record" ? [[B_EVENT.payload]] : [[]]);
      expect(gateway.eventLog.map((event) => event.payload)).toEqual(
        action === "record" ? [B_EVENT.payload] : [],
      );
      expect(clients[1]?.started).toBe(action === "record" ? 1 : 0);
      if (action === "replace") {
        expect(gateway.connection.gatewayUrl).toBe(C_URL);
        expect(current().started).toBe(1);
      } else if (action === "stop") {
        expect(gateway.snapshot.phase).toBe("stopped");
      }
    },
  );

  it.each(["replace", "stop"] as const)(
    "publishes retirement when a connecting snapshot subscriber %ss the new client",
    (action) => {
      const { gateway, clients } = store;
      const observed = vi.fn<(events: readonly EventLogEntry[]) => void>();
      gateway.subscribeEventLog(observed);
      let armed = true;
      gateway.subscribe((snapshot) => {
        if (!armed || snapshot.phase !== "connecting" || gateway.connection.gatewayUrl !== B_URL) {
          return;
        }
        armed = false;
        if (action === "replace") {
          gateway.connect({ gatewayUrl: C_URL });
        } else {
          gateway.stop();
        }
      });

      gateway.connect({ gatewayUrl: B_URL });

      expect(observed).toHaveBeenLastCalledWith([]);
      expect(gateway.eventLog).toEqual([]);
      expect(clients[1]?.started).toBe(0);
    },
  );

  it.each(["replace", "stop"] as const)(
    "does not publish an account hello after its retirement subscriber %ss the client",
    (action) => {
      const { gateway, current } = store;
      const retired = current();
      const connectedScopes: Array<string | undefined> = [];
      gateway.subscribe((snapshot) => {
        if (snapshot.phase === "connected") {
          connectedScopes.push(snapshot.hello?.auth?.recoveryScope);
        }
      });
      let armed = true;
      gateway.subscribeEventLog((events) => {
        if (!armed || events.length > 0) {
          return;
        }
        armed = false;
        if (action === "replace") {
          gateway.connect({ gatewayUrl: C_URL });
        } else {
          gateway.stop();
        }
      });

      retired.opts.onHello?.(hello("account-b"));

      expect(connectedScopes).toEqual([]);
      expect(gateway.snapshot.phase).toBe(action === "replace" ? "connecting" : "stopped");
      expect(gateway.eventLog).toEqual([]);
    },
  );
});

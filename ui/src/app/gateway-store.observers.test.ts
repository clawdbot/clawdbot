// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayEventFrame,
  GatewayHelloOk,
} from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

vi.mock("../build-info.ts", () => ({
  CONTROL_UI_BUILD_INFO: { version: "2026.7.2" },
}));

const HELLO: GatewayHelloOk = {
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: [] },
};

function createGatewayEvent(seq: number): GatewayEventFrame {
  return {
    type: "event",
    event: "chat",
    payload: { text: `event-${seq}` },
    seq,
    stateVersion: { presence: seq, health: seq },
  };
}

function createGatewayStore() {
  const clients: Array<{
    opts: GatewayBrowserClientOptions;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const gateway = createApplicationGateway(loadSettings(), "", "", (opts) => {
    const client = {
      opts,
      instanceId: opts.instanceId ?? "",
      request: vi.fn().mockRejectedValue(new Error("unexpected gateway request")),
      start: vi.fn(),
      stop: vi.fn(),
    };
    clients.push(client);
    return client as unknown as GatewayBrowserClient;
  });
  return {
    gateway,
    clients,
    current: () => {
      const client = clients.at(-1);
      if (!client) {
        throw new Error("expected a gateway client");
      }
      return client;
    },
  };
}

describe("application gateway observer ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "127.0.0.1:18789",
      hostname: "127.0.0.1",
      pathname: "/",
    } as Location);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("isolates a failing snapshot observer during the actual hello callback", () => {
    const { gateway, current } = createGatewayStore();
    const failure = new Error("snapshot observer failed");
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    gateway.subscribe((snapshot) => {
      if (snapshot.phase === "connected") {
        throw failure;
      }
    });
    gateway.subscribe(healthy);
    gateway.start();

    expect(() => current().opts.onHello?.(HELLO)).not.toThrow();

    expect(gateway.snapshot.phase).toBe("connected");
    expect(healthy.mock.calls.map(([snapshot]) => snapshot.phase)).toEqual([
      "connecting",
      "connected",
    ]);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      "[gateway] snapshot handler error:",
      failure,
    );
  });

  it("snapshots connection observers before subscription membership changes", () => {
    const { gateway, current } = createGatewayStore();
    const second = vi.fn();
    const third = vi.fn();
    let unsubscribeSecond = () => {};
    gateway.subscribe((snapshot) => {
      if (snapshot.phase === "connecting") {
        unsubscribeSecond();
        gateway.subscribe(third);
      }
    });
    unsubscribeSecond = gateway.subscribe(second);

    gateway.start();

    expect(second).toHaveBeenCalledOnce();
    expect(second.mock.calls[0]?.[0].phase).toBe("connecting");
    expect(third).not.toHaveBeenCalled();

    current().opts.onHello?.(HELLO);

    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
    expect(third.mock.calls[0]?.[0].phase).toBe("connected");
  });

  it("retires a snapshot immediately when an observer replaces its gateway client", () => {
    const { gateway, current } = createGatewayStore();
    const healthy = vi.fn();
    let replaced = false;
    gateway.subscribe((snapshot) => {
      if (snapshot.phase === "connected" && !replaced) {
        replaced = true;
        gateway.connect();
      }
    });
    gateway.subscribe(healthy);
    gateway.start();

    current().opts.onHello?.(HELLO);

    expect(gateway.snapshot.phase).toBe("reconnecting");
    expect(healthy.mock.calls.map(([snapshot]) => snapshot.phase)).toEqual([
      "connecting",
      "reconnecting",
    ]);
  });

  it("isolates a failing event-log observer from the remaining log observers", () => {
    const { gateway, current } = createGatewayStore();
    const failure = new Error("event log observer failed");
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    gateway.subscribeEventLog(() => {
      throw failure;
    });
    gateway.subscribeEventLog(healthy);
    gateway.start();

    current().opts.onEvent?.(createGatewayEvent(1));

    expect(healthy).toHaveBeenCalledExactlyOnceWith(gateway.eventLog);
    expect(reportError).toHaveBeenCalledExactlyOnceWith("[gateway] event handler error:", failure);
  });

  it("snapshots event-log observers before subscription membership changes", () => {
    const { gateway, current } = createGatewayStore();
    const second = vi.fn();
    const third = vi.fn();
    let unsubscribeSecond = () => {};
    gateway.subscribeEventLog(() => {
      unsubscribeSecond();
      gateway.subscribeEventLog(third);
    });
    unsubscribeSecond = gateway.subscribeEventLog(second);
    gateway.start();

    current().opts.onEvent?.(createGatewayEvent(1));

    expect(second).toHaveBeenCalledOnce();
    expect(third).not.toHaveBeenCalled();

    current().opts.onEvent?.(createGatewayEvent(2));

    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledExactlyOnceWith(gateway.eventLog);
  });

  it.each(["replace", "stop"] as const)(
    "retires remaining event-log observers when the first observer %ss its client",
    (action) => {
      const { gateway, clients, current } = createGatewayStore();
      const stale = vi.fn();
      const delivered = vi.fn();
      gateway.subscribeEventLog(() => {
        if (action === "replace") {
          gateway.connect();
        } else {
          gateway.stop();
        }
      });
      gateway.subscribeEventLog(stale);
      gateway.subscribeEvents(delivered);
      gateway.start();
      const retired = current();
      retired.opts.onHello?.(HELLO);

      retired.opts.onEvent?.(createGatewayEvent(1));

      expect(stale).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      expect(gateway.eventLog).toHaveLength(1);
      expect(clients).toHaveLength(action === "replace" ? 2 : 1);
      expect(gateway.snapshot.phase).toBe(action === "replace" ? "reconnecting" : "stopped");
    },
  );

  it("retires an older event-log snapshot after a reentrant event is recorded", () => {
    const { gateway, current } = createGatewayStore();
    const observed: number[] = [];
    let nested = false;
    gateway.subscribeEventLog(() => {
      if (!nested) {
        nested = true;
        current().opts.onEvent?.(createGatewayEvent(2));
      }
    });
    gateway.subscribeEventLog((events) => observed.push(events.length));
    gateway.start();
    current().opts.onHello?.(HELLO);

    current().opts.onEvent?.(createGatewayEvent(1));

    expect(observed).toEqual([2]);
    expect(gateway.eventLog.map((event) => event.payload)).toEqual([
      { text: "event-2" },
      { text: "event-1" },
    ]);
  });

  it("never logs a presence event after its snapshot observer replaces the client", () => {
    const { gateway, current } = createGatewayStore();
    const logged = vi.fn();
    const delivered = vi.fn();
    let replaced = false;
    gateway.subscribe((snapshot) => {
      if (snapshot.selfUser?.id === "retired-owner" && !replaced) {
        replaced = true;
        gateway.connect();
      }
    });
    gateway.subscribeEventLog(logged);
    gateway.subscribeEvents(delivered);
    gateway.start();
    const retired = current();
    retired.opts.onHello?.(HELLO);

    retired.opts.onEvent?.({
      ...createGatewayEvent(1),
      event: "presence",
      payload: {
        presence: [{ instanceId: retired.opts.instanceId, user: { id: "retired-owner" } }],
      },
    });

    expect(replaced).toBe(true);
    expect(gateway.snapshot.selfUser).toBeNull();
    expect(gateway.eventLog).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
  });

  it("does not start a client replaced by a connecting snapshot observer", () => {
    const { gateway, clients } = createGatewayStore();
    let replaced = false;
    gateway.subscribe((snapshot) => {
      if (snapshot.phase === "connecting" && !replaced) {
        replaced = true;
        gateway.connect();
      }
    });

    gateway.start();

    expect(clients).toHaveLength(2);
    expect(clients[0]?.stop).toHaveBeenCalledOnce();
    expect(clients[0]?.start).not.toHaveBeenCalled();
    expect(clients[1]?.start).toHaveBeenCalledOnce();
  });

  it("does not start a client stopped by a connecting snapshot observer", () => {
    const { gateway, clients } = createGatewayStore();
    let halted = false;
    gateway.subscribe((snapshot) => {
      if (snapshot.phase === "connecting" && !halted) {
        halted = true;
        gateway.stop();
      }
    });

    gateway.start();

    expect(clients).toHaveLength(1);
    expect(clients[0]?.stop).toHaveBeenCalledOnce();
    expect(clients[0]?.start).not.toHaveBeenCalled();
    expect(gateway.snapshot.phase).toBe("stopped");
  });

  it("does not reconnect again after a gap observer replaces its client", () => {
    const { gateway, clients } = createGatewayStore();
    gateway.start();
    const retired = clients[0];
    retired?.opts.onHello?.(HELLO);
    let replaced = false;
    gateway.subscribe((snapshot) => {
      if (snapshot.lastError?.startsWith("event gap detected") && !replaced) {
        replaced = true;
        gateway.connect();
      }
    });

    retired?.opts.onGap?.({ expected: 2, received: 5 });

    expect(replaced).toBe(true);
    expect(clients).toHaveLength(2);
    expect(clients[1]?.start).toHaveBeenCalledOnce();
    expect(gateway.snapshot.client).toBe(clients[1]);
  });

  it("does not reconnect after a gap observer stops its client", () => {
    const { gateway, clients } = createGatewayStore();
    gateway.start();
    const retired = clients[0];
    retired?.opts.onHello?.(HELLO);
    let halted = false;
    gateway.subscribe((snapshot) => {
      if (snapshot.lastError?.startsWith("event gap detected") && !halted) {
        halted = true;
        gateway.stop();
      }
    });

    retired?.opts.onGap?.({ expected: 2, received: 5 });

    expect(halted).toBe(true);
    expect(clients).toHaveLength(1);
    expect(retired?.start).toHaveBeenCalledOnce();
    expect(gateway.snapshot.phase).toBe("stopped");
  });
});

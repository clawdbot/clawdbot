// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayHelloOk,
} from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

const HELLO: GatewayHelloOk = {
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: [] },
};

class FakeGatewayClient {
  started = 0;
  stopped = 0;

  constructor(readonly opts: GatewayBrowserClientOptions) {}

  start() {
    this.started += 1;
  }

  stop() {
    this.stopped += 1;
  }

  addEventListener() {
    return () => {};
  }
}

function createStore() {
  const clients: FakeGatewayClient[] = [];
  const gateway = createApplicationGateway(loadSettings(), "", "", (opts) => {
    const client = new FakeGatewayClient(opts);
    clients.push(client);
    return client as unknown as GatewayBrowserClient;
  });
  const current = () => {
    const client = clients.at(-1);
    if (!client) {
      throw new Error("expected a gateway client");
    }
    return client;
  };
  return { gateway, clients, current };
}

describe("createApplicationGateway reconnecting snapshot", () => {
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the first connect attempt on the login gate (not reconnecting)", () => {
    const { gateway, current } = createStore();
    gateway.start();

    expect(current().started).toBe(1);
    expect(gateway.snapshot.connected).toBe(false);
    expect(gateway.snapshot.reconnecting).toBe(false);
  });

  it("stays on the gate when the first connect fails, even with auto-retry pending", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({ code: 1006, reason: "refused", willRetry: true });

    expect(gateway.snapshot.connected).toBe(false);
    expect(gateway.snapshot.reconnecting).toBe(false);
    expect(gateway.snapshot.lastError).toContain("1006");
  });

  it("marks transport drops after an established session as reconnecting", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.connected).toBe(true);

    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });

    expect(gateway.snapshot.connected).toBe(false);
    expect(gateway.snapshot.reconnecting).toBe(true);
  });

  it("drops back to the gate when the client gives up (credential rejection)", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);

    current().opts.onClose?.({ code: 4008, reason: "connect failed", willRetry: false });

    expect(gateway.snapshot.connected).toBe(false);
    expect(gateway.snapshot.reconnecting).toBe(false);
  });

  it("keeps reconnecting across event-gap recovery with a fresh client", () => {
    const { gateway, clients, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);

    current().opts.onGap?.({ expected: 2, received: 5 });

    expect(clients).toHaveLength(2);
    expect(clients[0]?.stopped).toBe(1);
    expect(current().started).toBe(1);
    expect(gateway.snapshot.reconnecting).toBe(true);
    expect(gateway.snapshot.connected).toBe(false);
  });

  it("resets the session lineage on stop so the next start uses the gate again", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    gateway.stop();

    expect(gateway.snapshot.reconnecting).toBe(false);

    gateway.start();
    current().opts.onClose?.({ code: 1006, reason: "refused", willRetry: true });

    expect(gateway.snapshot.reconnecting).toBe(false);
  });

  it("ignores close callbacks from superseded clients", () => {
    const { gateway, clients, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    const stale = current();
    gateway.connect();
    expect(clients).toHaveLength(2);

    stale.opts.onClose?.({ code: 1006, reason: "stale", willRetry: false });

    // The superseded client cannot demote the fresh attempt's snapshot.
    expect(gateway.snapshot.reconnecting).toBe(true);
  });
});

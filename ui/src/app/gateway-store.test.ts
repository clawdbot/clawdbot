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

vi.mock("../build-info.ts", () => ({
  CONTROL_UI_BUILD_INFO: {
    version: "2026.7.19",
    commit: null,
    commitAt: null,
    builtAt: null,
    branch: null,
    dirty: null,
    buildId: "test",
  },
}));

const HELLO: GatewayHelloOk = {
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: [] },
};

class FakeGatewayClient {
  started = 0;
  stopped = 0;
  readonly instanceId: string;

  constructor(readonly opts: GatewayBrowserClientOptions) {
    this.instanceId = opts.instanceId ?? "";
  }

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

function createStore(
  params: {
    settings?: ReturnType<typeof loadSettings>;
    persistDefaultConnectionSettings?: boolean;
  } = {},
) {
  const clients: FakeGatewayClient[] = [];
  const gateway = createApplicationGateway(
    params.settings ?? loadSettings(),
    "",
    "",
    (opts) => {
      const client = new FakeGatewayClient(opts);
      clients.push(client);
      return client as unknown as GatewayBrowserClient;
    },
    { persistDefaultConnectionSettings: params.persistDefaultConnectionSettings },
  );
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
    expect(current().opts.clientVersion).toBe("2026.7.19");
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

  it("projects only this browser connection's optional presence identity", () => {
    const { gateway, current } = createStore();
    gateway.start();
    const instanceId = current().opts.instanceId;
    current().opts.onHello?.({
      ...HELLO,
      snapshot: {
        presence: [
          { instanceId: "someone-else", user: { id: "other", name: "Other" } },
          {
            instanceId,
            user: { id: "profile-1", email: "ada@example.test", name: "Ada" },
          },
        ],
      },
    });

    expect(gateway.snapshot.selfUser).toEqual({
      id: "profile-1",
      email: "ada@example.test",
      name: "Ada",
    });

    gateway.updateSelfUser?.({ name: "Augusta Ada", avatarUrl: "/api/users/profile-1/avatar?v=2" });
    expect(gateway.snapshot.selfUser).toMatchObject({
      id: "profile-1",
      name: "Augusta Ada",
      avatarUrl: "/api/users/profile-1/avatar?v=2",
    });

    current().opts.onEvent?.({
      type: "event",
      event: "presence",
      payload: {
        presence: [
          {
            instanceId,
            user: {
              id: "profile-1",
              email: "ada@example.test",
              name: "Ada Lovelace",
              avatarUrl: "/api/users/profile-1/avatar?v=3",
            },
          },
        ],
      },
      seq: 1,
      stateVersion: { presence: 1, health: 1 },
    });
    expect(gateway.snapshot.selfUser).toMatchObject({
      id: "profile-1",
      name: "Ada Lovelace",
      avatarUrl: "/api/users/profile-1/avatar?v=3",
    });

    current().opts.onEvent?.({
      type: "event",
      event: "presence",
      payload: { presence: [{ instanceId: "anonymous" }] },
      seq: 2,
      stateVersion: { presence: 2, health: 1 },
    });
    expect(gateway.snapshot.selfUser).toBeNull();
  });

  it("clears identity while disconnected", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.({
      ...HELLO,
      snapshot: {
        presence: [
          { instanceId: current().opts.instanceId, user: { id: "profile-1", name: "Ada" } },
        ],
      },
    });

    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });

    expect(gateway.snapshot.selfUser).toBeNull();
  });

  it("does not copy selected-remote settings into an ephemeral document Gateway", () => {
    const pageGateway = "ws://127.0.0.1:18789";
    const remoteGateway = "wss://saved-remote.example.test";
    const pageSettingsKey = `openclaw.control.settings.v1:${pageGateway}`;
    const selectionKey = `openclaw.control.currentGateway.v1:${pageGateway}`;
    const storedPageSettings = JSON.stringify({
      gatewayUrl: pageGateway,
      theme: "claw",
      sessionKey: "agent:page:saved",
    });
    const settings = {
      ...loadSettings(),
      gatewayUrl: pageGateway,
      token: "page-token",
      theme: "dash" as const,
      sessionKey: "agent:page:document",
      lastActiveSessionKey: "agent:page:document",
    };
    localStorage.setItem(pageSettingsKey, storedPageSettings);
    localStorage.setItem(selectionKey, remoteGateway);
    const { gateway, current } = createStore({
      settings,
      persistDefaultConnectionSettings: false,
    });

    gateway.start();
    expect(current().opts.token).toBe("page-token");
    current().opts.onHello?.(HELLO);
    gateway.connect({ token: "replacement-page-token" });

    expect(current().opts.token).toBe("replacement-page-token");
    expect(localStorage.getItem(pageSettingsKey)).toBe(storedPageSettings);
    expect(localStorage.getItem(selectionKey)).toBe(remoteGateway);
  });

  it("keeps ephemeral login on the serving gateway from persisting the selection", () => {
    const pageGateway = "ws://127.0.0.1:18789";
    const remoteGateway = "wss://saved-remote.example.test";
    const otherGateway = "wss://other-remote.example.test";
    const pageSettingsKey = `openclaw.control.settings.v1:${pageGateway}`;
    const selectionKey = `openclaw.control.currentGateway.v1:${pageGateway}`;
    const settings = {
      ...loadSettings(),
      gatewayUrl: pageGateway,
      token: "",
    };
    localStorage.setItem(selectionKey, remoteGateway);
    const { gateway, current } = createStore({
      settings,
      persistDefaultConnectionSettings: false,
    });

    gateway.start();
    // The login gate always resubmits its prefilled (serving) gateway URL;
    // an unchanged URL must not count as an explicit gateway selection.
    gateway.connect({ gatewayUrl: pageGateway, token: "approval-token", password: "pw" });

    expect(current().opts.url).toBe(pageGateway);
    expect(current().opts.token).toBe("approval-token");
    expect(localStorage.getItem(pageSettingsKey)).toBeNull();
    expect(localStorage.getItem(selectionKey)).toBe(remoteGateway);

    // A genuinely changed URL is an explicit selection and persists.
    gateway.connect({ gatewayUrl: otherGateway });

    expect(current().opts.url).toBe(otherGateway);
    expect(localStorage.getItem(selectionKey)).toBe(otherGateway);
  });
});

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

  request = vi.fn(
    (_method: string, _params: unknown): Promise<unknown> =>
      Promise.reject(new Error("unexpected gateway request")),
  );

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

describe("createApplicationGateway connection phase", () => {
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

  it("follows stopped -> connecting -> connected -> reconnecting -> offline", () => {
    const { gateway, current } = createStore();

    expect(gateway.snapshot.phase).toBe("stopped");
    gateway.start();

    expect(current().started).toBe(1);
    expect(current().opts.clientVersion).toBe("2026.7.19");
    expect(gateway.snapshot.phase).toBe("connecting");

    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.phase).toBe("connected");

    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
    expect(gateway.snapshot.phase).toBe("reconnecting");

    current().opts.onClose?.({ code: 4008, reason: "connect failed", willRetry: false });
    expect(gateway.snapshot.phase).toBe("offline");
  });

  it("does not invent an assistant agent id before the gateway advertises one", () => {
    const { gateway, current } = createStore();

    expect(gateway.snapshot.assistantAgentId).toBeNull();
    gateway.start();
    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.assistantAgentId).toBeNull();

    gateway.connect();
    current().opts.onHello?.({
      ...HELLO,
      snapshot: { sessionDefaults: { defaultAgentId: "roboclaw" } },
    });
    expect(gateway.snapshot.assistantAgentId).toBe("roboclaw");
    gateway.stop();
    expect(gateway.snapshot.assistantAgentId).toBeNull();
  });

  it("publishes the hello canvas URL synchronously and clears it on disconnect", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.({
      ...HELLO,
      pluginSurfaceUrls: {
        canvas: "https://canvas.test/__openclaw__/cap/hello",
      },
    });

    expect(gateway.snapshot.canvasPluginSurfaceUrl).toBe(
      "https://canvas.test/__openclaw__/cap/hello",
    );

    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
    expect(gateway.snapshot.canvasPluginSurfaceUrl).toBeNull();
  });

  it("does not let a superseded canvas refresh publish into the current snapshot", async () => {
    let resolveRefresh: (value: unknown) => void = () => {};
    const firstRefresh = new Promise<unknown>((resolve) => {
      resolveRefresh = resolve;
    });
    const { gateway, current } = createStore();
    gateway.start();
    const first = current();
    first.request.mockReturnValueOnce(firstRefresh);
    first.opts.onHello?.({
      ...HELLO,
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/first" },
    });
    await vi.waitFor(() => expect(first.request).toHaveBeenCalledOnce());

    gateway.connect();
    current().opts.onHello?.({
      ...HELLO,
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/current" },
    });
    resolveRefresh({
      surface: "canvas",
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/stale-refresh" },
      expiresAtMs: Date.now() + 60_000,
    });
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });

    expect(gateway.snapshot.canvasPluginSurfaceUrl).toBe(
      "https://canvas.test/__openclaw__/cap/current",
    );
    gateway.stop();
  });

  it("stays on the gate when the first connect fails, even with auto-retry pending", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({ code: 1006, reason: "refused", willRetry: true });

    expect(gateway.snapshot.phase).toBe("connecting");
    expect(gateway.snapshot.lastError).toContain("1006");
  });

  it("returns a never-connected terminal close to stopped", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({ code: 4008, reason: "connect failed", willRetry: false });

    expect(gateway.snapshot.phase).toBe("stopped");
    expect(gateway.snapshot.lastError).toContain("4008");
  });

  it.each(["stopped", "connecting", "connected", "reconnecting", "offline"] as const)(
    "stop() resets %s to stopped",
    (phase) => {
      const { gateway, current } = createStore();
      if (phase !== "stopped") {
        gateway.start();
      }
      if (phase === "connected" || phase === "reconnecting" || phase === "offline") {
        current().opts.onHello?.(HELLO);
      }
      if (phase === "reconnecting" || phase === "offline") {
        current().opts.onClose?.({
          code: 1006,
          reason: "socket lost",
          willRetry: phase === "reconnecting",
        });
      }
      expect(gateway.snapshot.phase).toBe(phase);

      gateway.stop();

      expect(gateway.snapshot.phase).toBe("stopped");
      expect(gateway.snapshot.client).toBeNull();
      expect(gateway.snapshot.offlineStable).toBe(false);
    },
  );

  it("publishes a stable offline state only after a sustained disconnect", async () => {
    vi.useFakeTimers();
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);

    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
    expect(gateway.snapshot.offlineStable).toBe(false);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(gateway.snapshot.offlineStable).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.snapshot.offlineStable).toBe(true);
  });

  it("does not publish offline before the gateway starts", async () => {
    vi.useFakeTimers();
    const { gateway } = createStore();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(gateway.snapshot.offlineStable).toBe(false);
  });

  it("keeps a sub-two-second connection blip quiet", async () => {
    vi.useFakeTimers();
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);

    current().opts.onClose?.({ code: 1006, reason: "brief blip", willRetry: true });
    await vi.advanceTimersByTimeAsync(1_999);
    current().opts.onHello?.(HELLO);
    await vi.advanceTimersByTimeAsync(1);

    expect(gateway.snapshot.offlineStable).toBe(false);
  });

  it("clears a stable offline state immediately on reconnect", async () => {
    vi.useFakeTimers();
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(gateway.snapshot.offlineStable).toBe(true);

    current().opts.onHello?.(HELLO);

    expect(gateway.snapshot.offlineStable).toBe(false);
  });

  it("clears the pending offline timer when stopped", async () => {
    vi.useFakeTimers();
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });

    gateway.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(gateway.snapshot.offlineStable).toBe(false);
  });

  it("drops back to the gate when the client gives up (credential rejection)", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);

    current().opts.onClose?.({ code: 4008, reason: "connect failed", willRetry: false });

    expect(gateway.snapshot.phase).toBe("offline");
  });

  it("keeps reconnecting across event-gap recovery with a fresh client", () => {
    const { gateway, clients, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);

    current().opts.onGap?.({ expected: 2, received: 5 });

    expect(clients).toHaveLength(2);
    expect(clients[0]?.stopped).toBe(1);
    expect(current().started).toBe(1);
    expect(gateway.snapshot.phase).toBe("reconnecting");
  });

  it("resets the session lineage on stop so the next start uses the gate again", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    gateway.stop();

    expect(gateway.snapshot.phase).toBe("stopped");

    gateway.start();
    current().opts.onClose?.({ code: 1006, reason: "refused", willRetry: true });

    expect(gateway.snapshot.phase).toBe("connecting");
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
    expect(gateway.snapshot.phase).toBe("reconnecting");
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
    expect(gateway.snapshot.selfUser).toMatchObject({
      id: "profile-1",
      name: "Ada Lovelace",
      avatarUrl: "/api/users/profile-1/avatar?v=3",
    });
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

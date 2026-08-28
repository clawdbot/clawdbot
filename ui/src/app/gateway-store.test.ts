// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { resolveAvatar } from "../lib/identity-avatar.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore as createStore,
  GATEWAY_STORE_TEST_HELLO as HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { loadSettings } from "./settings.ts";

const { scheduleStaleChunkReloadMock } = vi.hoisted(() => ({
  scheduleStaleChunkReloadMock: vi.fn(async () => true),
}));

vi.mock("./stale-chunk-reload.ts", () => ({
  scheduleStaleChunkReload: scheduleStaleChunkReloadMock,
}));

vi.mock("../build-info.ts", () => ({
  CONTROL_UI_BUILD_INFO: {
    version: "2026.7.19",
    commit: null,
    commitAt: null,
    builtAt: null,
    branch: null,
    dirty: null,
    release: false,
    buildId: "test",
  },
  controlUiBuildDiffersFrom: (identity: {
    version?: string | null;
    buildId?: string | null;
    controlUiBuildSource?: "bundled" | "configured";
  }) =>
    identity.controlUiBuildSource === "configured"
      ? false
      : identity.buildId
        ? identity.buildId !== "test"
        : Boolean(identity.version && identity.version !== "2026.7.19"),
}));

describe("createApplicationGateway connection phase", () => {
  beforeEach(() => {
    scheduleStaleChunkReloadMock.mockClear();
    stubGatewayStoreTestGlobals();
  });

  afterEach(() => {
    setAvatarGatewayOrigin(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes the explicit same-origin resource base to avatar resolution", () => {
    const settings = { ...loadSettings(), gatewayUrl: "ws://127.0.0.1:18789/ws" };
    const { gateway } = createStore({ settings, resourceBasePath: "/wilfred" });

    gateway.start();

    expect(
      resolveAvatar({ id: "a@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).toEqual({
      kind: "profile",
      url: "http://127.0.0.1:18789/wilfred/api/users/p1/avatar",
    });
  });

  it("follows stopped -> connecting -> connected -> reconnecting -> offline", () => {
    const { gateway, current } = createStore();

    expect(gateway.snapshot.phase).toBe("stopped");
    gateway.start();

    expect(current().started).toBe(1);
    expect(current().opts.clientVersion).toBe("2026.7.19");
    expect(current().opts.clientBuildId).toBe("test");
    expect(gateway.snapshot.phase).toBe("connecting");

    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.phase).toBe("connected");

    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
    expect(gateway.snapshot.phase).toBe("reconnecting");

    current().opts.onClose?.({ code: 4008, reason: "connect failed", willRetry: false });
    expect(gateway.snapshot.phase).toBe("offline");
  });

  it("keeps legacy version fallback on reconnect instead of first admission", () => {
    const { gateway, current } = createStore();
    gateway.start();
    const legacyHello = {
      ...HELLO,
      server: { version: "2026.7.20", connId: "legacy-conn" },
    };

    current().opts.onHello?.(legacyHello);
    expect(gateway.snapshot.phase).toBe("connected");

    current().opts.onClose?.({ code: 1006, reason: "restarting", willRetry: true });
    current().opts.onHello?.(legacyHello);
    expect(gateway.snapshot.phase).toBe("reconnecting");
  });

  it("does not compare a separately hosted Control UI with a remote gateway build", () => {
    const settings = { ...loadSettings(), gatewayUrl: "wss://remote.example/ws" };
    const { gateway, current } = createStore({ settings });
    gateway.start();

    current().opts.onHello?.({
      ...HELLO,
      server: { version: "2026.7.19", buildId: "remote-build", connId: "conn-1" },
    });

    expect(gateway.snapshot.phase).toBe("connected");
  });

  it("does not compare a configured same-origin Control UI with the gateway package", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onHello?.({
      ...HELLO,
      server: {
        version: "2026.7.20",
        controlUiBuildSource: "configured",
        connId: "conn-1",
      },
    });

    expect(gateway.snapshot.phase).toBe("connected");
  });

  it.each([
    {
      name: "missing-token auth detail",
      outerCode: "INVALID_REQUEST",
      detailCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
      message: "token missing",
    },
    {
      name: "pairing-required detail",
      outerCode: "NOT_PAIRED",
      detailCode: ConnectErrorDetailCodes.PAIRING_REQUIRED,
      message: "device is not approved",
    },
  ])("preserves the structured $name in the login snapshot", (fixture) => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({
      code: 4008,
      reason: "connect failed",
      error: {
        code: fixture.outerCode,
        message: fixture.message,
        details: { code: fixture.detailCode },
      },
      willRetry: false,
    });

    expect(gateway.snapshot.lastError).toBe(fixture.message);
    expect(gateway.snapshot.lastErrorCode).toBe(fixture.detailCode);
  });

  it("preserves an outer code when a transport failure has no structured detail", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({
      code: 1006,
      reason: "websocket error",
      error: { code: "UNAVAILABLE", message: "WebSocket connection failed" },
      willRetry: false,
    });

    expect(gateway.snapshot.lastError).toBe("WebSocket connection failed");
    expect(gateway.snapshot.lastErrorCode).toBe("UNAVAILABLE");
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

  it("keeps retryable startup unavailable in the initial progress state", () => {
    const { gateway, current } = createStore();
    gateway.start();

    const startupClose = {
      code: 4013,
      reason: "gateway starting",
      willRetry: true,
      error: {
        code: "UNAVAILABLE",
        message: "gateway starting; retry shortly",
        details: { reason: "startup-sidecars" },
        retryable: true,
        retryAfterMs: 250,
      },
    };
    current().opts.onClose?.(startupClose);

    expect(gateway.snapshot.phase).toBe("starting");
    expect(gateway.snapshot.lastError).toBeNull();
    expect(gateway.snapshot.lastErrorCode).toBeNull();

    const listener = vi.fn();
    gateway.subscribe(listener);
    current().opts.onClose?.(startupClose);
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns a never-connected terminal close to stopped", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({ code: 4008, reason: "connect failed", willRetry: false });

    expect(gateway.snapshot.phase).toBe("stopped");
    expect(gateway.snapshot.lastError).toContain("4008");
  });

  it("redacts a secret-shaped WebSocket close reason", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({
      code: 1006,
      reason: "OPENAI_API_KEY=sk-1234567890abcdef",
      willRetry: true,
    });

    expect(gateway.snapshot.lastError).toContain("OPENAI_API_KEY=sk-123...cdef");
    expect(gateway.snapshot.lastError).not.toContain("sk-1234567890abcdef");
  });

  it("uses translated fallback copy for an empty WebSocket close reason", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({ code: 1006, reason: "", willRetry: true });

    expect(gateway.snapshot.lastError).toBe("disconnected (1006): Unknown");
  });

  it("starts a newly selected Gateway as a fresh connection", () => {
    const { gateway, clients, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);

    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test", token: "other-token" });

    expect(clients[0]?.stopped).toBe(1);
    expect(current().opts.url).toBe("wss://other-gateway.example.test");
    expect(current().opts.token).toBe("other-token");
    expect(gateway.snapshot.phase).toBe("connecting");
  });

  it("restores the newly selected Gateway's saved agent", () => {
    const otherGateway = "wss://other-gateway.example.test";
    localStorage.setItem(
      `openclaw.control.settings.v1:${otherGateway}`,
      JSON.stringify({
        gatewayUrl: otherGateway,
        sessionsByGateway: {
          [otherGateway]: {
            sessionKey: "global",
            lastActiveSessionKey: "global",
            selectedAgentId: "research",
          },
        },
      }),
    );
    const { gateway } = createStore({
      settings: { ...loadSettings(), selectedAgentId: "openclaw" },
    });

    gateway.connect({ gatewayUrl: otherGateway });

    expect(gateway.snapshot.sessionKey).toBe("global");
    expect(loadSettings()).toMatchObject({
      sessionKey: "global",
      lastActiveSessionKey: "global",
      selectedAgentId: "research",
    });
  });

  it("does not carry an agent selection into an unsaved Gateway", () => {
    const { gateway } = createStore({
      settings: { ...loadSettings(), selectedAgentId: "openclaw" },
    });

    gateway.connect({ gatewayUrl: "wss://fresh-gateway.example.test" });

    expect(loadSettings().selectedAgentId).toBeUndefined();
  });

  it("advances the connection revision only when credentials change", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);

    expect(gateway.connectionRevision).toBe(0);
    gateway.connect({ sessionKey: "agent:main:other" });
    expect(gateway.connectionRevision).toBe(0);

    gateway.connect({ token: "replacement-token" });
    expect(gateway.connectionRevision).toBe(1);
  });

  it("keeps a newly selected Gateway's first retry at the login gate", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });

    current().opts.onClose?.({ code: 1006, reason: "remote refused", willRetry: true });

    expect(gateway.snapshot.phase).toBe("connecting");
    expect(gateway.snapshot.lastError).toBe("disconnected (1006): remote refused");
  });

  it("treats a newly selected Gateway's first terminal close as never connected", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });

    current().opts.onClose?.({ code: 4008, reason: "remote rejected", willRetry: false });

    expect(gateway.snapshot.phase).toBe("stopped");
    expect(gateway.snapshot.lastError).toBe("disconnected (4008): remote rejected");
  });

  it("retains a newly selected Gateway's shell after its own successful hello", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });
    current().opts.onHello?.(HELLO);

    current().opts.onClose?.({ code: 1006, reason: "remote blip", willRetry: true });

    expect(gateway.snapshot.phase).toBe("reconnecting");
  });

  it("preserves an established Gateway's lineage when its unchanged URL is resubmitted", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    const gatewayUrl = gateway.connection.gatewayUrl;

    gateway.connect({ gatewayUrl, token: "replacement-token", sessionKey: "agent:main:other" });

    expect(gateway.snapshot.phase).toBe("reconnecting");
    expect(current().opts.token).toBe("replacement-token");
    expect(gateway.snapshot.sessionKey).toBe("agent:main:other");
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

  it("schedules the guarded reload and publishes a terminal phase for a stale build", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({
      code: 1008,
      reason: "protocol mismatch: Control UI updated; reload this page to continue",
      error: {
        code: "UNAVAILABLE",
        message: "protocol mismatch: Control UI updated; reload this page to continue",
        details: {
          code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
          gatewayBuildId: "replacement-build",
          reloadRequired: true,
        },
      },
      willRetry: false,
    });

    expect(scheduleStaleChunkReloadMock).toHaveBeenCalledExactlyOnceWith({
      buildId: "replacement-build",
    });
    expect(gateway.snapshot.phase).toBe("reload-required");
  });

  it("keeps reload-required ahead of retryable startup presentation", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({
      code: 1008,
      reason: "protocol mismatch: Control UI updated; reload this page to continue",
      error: {
        code: "UNAVAILABLE",
        message: "protocol mismatch: Control UI updated; reload this page to continue",
        details: {
          code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
          reason: "startup-sidecars",
          gatewayBuildId: "replacement-build",
          reloadRequired: true,
        },
        retryable: true,
      },
      willRetry: true,
    });

    expect(scheduleStaleChunkReloadMock).toHaveBeenCalledExactlyOnceWith({
      buildId: "replacement-build",
    });
    expect(gateway.snapshot.phase).toBe("reload-required");
    expect(gateway.snapshot.lastError).toContain("Control UI updated");
    expect(gateway.snapshot.lastErrorCode).toBe(ConnectErrorDetailCodes.PROTOCOL_MISMATCH);
  });

  it("keeps a bare protocol mismatch in the login-gate path", () => {
    const { gateway, current } = createStore();
    gateway.start();

    current().opts.onClose?.({
      code: 1008,
      reason: "protocol mismatch",
      error: {
        code: "INVALID_REQUEST",
        message: "protocol mismatch",
        details: { code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH },
      },
      willRetry: false,
    });

    expect(scheduleStaleChunkReloadMock).not.toHaveBeenCalled();
    expect(gateway.snapshot.phase).toBe("stopped");
    expect(gateway.snapshot.lastErrorCode).toBe(ConnectErrorDetailCodes.PROTOCOL_MISMATCH);
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

  it("discards the gapped frame after recovery synchronously replaces its client", () => {
    const { gateway, current } = createStore();
    const listener = vi.fn();
    gateway.subscribeEvents(listener);
    gateway.start();
    const stale = current();
    stale.opts.onHello?.(HELLO);

    // The protocol invokes onGap before onEvent for the same received frame.
    stale.opts.onGap?.({ expected: 2, received: 5 });
    stale.opts.onEvent?.(createGatewayEvent("stale.gap", { stale: true }, 5));

    expect(listener).not.toHaveBeenCalled();
    expect(gateway.eventLog).toEqual([]);

    const activeEvent = createGatewayEvent("fresh.event", { active: true }, 6);
    current().opts.onEvent?.(activeEvent);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(activeEvent);
    expect(gateway.eventLog).toMatchObject([{ event: "fresh.event", payload: { active: true } }]);
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

  it("fans active events out once without binding subscribers to the transport", () => {
    const { gateway, current } = createStore();
    const first = vi.fn();
    const second = vi.fn();
    gateway.subscribeEvents(first);
    gateway.start();
    const active = current();
    const addEventListener = vi.spyOn(active, "addEventListener");
    const unsubscribeSecond = gateway.subscribeEvents(second);
    const event = createGatewayEvent("chat", { text: "hello" });

    active.opts.onEvent?.(event);

    expect(first).toHaveBeenCalledExactlyOnceWith(event);
    expect(second).toHaveBeenCalledExactlyOnceWith(event);
    expect(addEventListener).not.toHaveBeenCalled();
    expect(gateway.eventLog).toMatchObject([{ event: "chat", payload: { text: "hello" } }]);

    unsubscribeSecond();
    const nextEvent = createGatewayEvent("chat", { text: "next" }, 2);
    active.opts.onEvent?.(nextEvent);

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledOnce();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("keeps event subscriptions across reconnects and a stopped gateway", () => {
    const { gateway, current } = createStore();
    const listener = vi.fn();
    gateway.subscribeEvents(listener);
    gateway.start();
    const first = current();
    const firstEvent = createGatewayEvent("chat", { text: "first connection" });
    first.opts.onEvent?.(firstEvent);

    gateway.connect();
    const second = current();
    first.opts.onEvent?.(createGatewayEvent("chat", { text: "stale connection" }, 2));
    const secondEvent = createGatewayEvent("chat", { text: "second connection" }, 3);
    second.opts.onEvent?.(secondEvent);

    gateway.stop();
    second.opts.onEvent?.(createGatewayEvent("chat", { text: "stopped connection" }, 4));

    gateway.start();
    const thirdEvent = createGatewayEvent("chat", { text: "restarted connection" }, 5);
    current().opts.onEvent?.(thirdEvent);

    expect(listener.mock.calls).toEqual([[firstEvent], [secondEvent], [thirdEvent]]);
    expect(gateway.eventLog.map((entry) => entry.payload)).toEqual([
      { text: "restarted connection" },
      { text: "second connection" },
      { text: "first connection" },
    ]);
  });

  it("snapshots subscribers when an event adds or removes another listener", () => {
    const { gateway, current } = createStore();
    const second = vi.fn();
    const third = vi.fn();
    let unsubscribeSecond = () => {};
    const first = vi.fn(() => {
      unsubscribeSecond();
      gateway.subscribeEvents(third);
    });
    gateway.subscribeEvents(first);
    unsubscribeSecond = gateway.subscribeEvents(second);
    gateway.start();
    const firstEvent = createGatewayEvent("chat", { text: "first" });

    current().opts.onEvent?.(firstEvent);

    expect(first).toHaveBeenCalledExactlyOnceWith(firstEvent);
    expect(second).toHaveBeenCalledExactlyOnceWith(firstEvent);
    expect(third).not.toHaveBeenCalled();

    const secondEvent = createGatewayEvent("chat", { text: "second" }, 2);
    current().opts.onEvent?.(secondEvent);

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledExactlyOnceWith(secondEvent);
  });

  it("isolates a failing subscriber from later event subscribers", () => {
    const { gateway, current } = createStore();
    const failure = new Error("subscriber failed");
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(() => {
      throw failure;
    });
    const healthy = vi.fn();
    gateway.subscribeEvents(failing);
    gateway.subscribeEvents(healthy);
    gateway.start();
    const event = createGatewayEvent("chat", { text: "still delivered" });

    current().opts.onEvent?.(event);

    expect(failing).toHaveBeenCalledExactlyOnceWith(event);
    expect(healthy).toHaveBeenCalledExactlyOnceWith(event);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      "[gateway] event listener handler error:",
      failure,
    );
    expect(gateway.eventLog).toMatchObject([
      { event: "chat", payload: { text: "still delivered" } },
    ]);
  });

  it("delivers active events when an event-log subscriber throws", () => {
    const { gateway, current } = createStore();
    const failure = new Error("event log subscriber failed");
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    gateway.subscribeEventLog(() => {
      throw failure;
    });
    const listener = vi.fn();
    gateway.subscribeEvents(listener);
    gateway.start();
    const event = createGatewayEvent("chat", { text: "still delivered" });

    current().opts.onEvent?.(event);

    expect(listener).toHaveBeenCalledExactlyOnceWith(event);
    expect(reportError).toHaveBeenCalledExactlyOnceWith("[gateway] event handler error:", failure);
    expect(gateway.eventLog).toMatchObject([
      { event: "chat", payload: { text: "still delivered" } },
    ]);
  });

  it("stops delivering a replaced client's event to remaining subscribers", () => {
    const { gateway, clients, current } = createStore();
    const first = vi.fn(() => gateway.connect());
    const second = vi.fn();
    gateway.subscribeEvents(first);
    gateway.subscribeEvents(second);
    gateway.start();
    const stale = current();
    const event = createGatewayEvent("chat", { text: "replace connection" });

    stale.opts.onEvent?.(event);

    expect(clients).toHaveLength(2);
    expect(first).toHaveBeenCalledExactlyOnceWith(event);
    expect(second).not.toHaveBeenCalled();

    const activeEvent = createGatewayEvent("chat", { text: "fresh connection" }, 2);
    current().opts.onEvent?.(activeEvent);

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
  });

  it("ignores queued events after the gateway is stopped", () => {
    const { gateway, current } = createStore();
    const listener = vi.fn();
    gateway.subscribeEvents(listener);
    gateway.start();
    const stale = current();

    gateway.stop();
    stale.opts.onEvent?.(createGatewayEvent("chat", { text: "stopped" }));

    expect(listener).not.toHaveBeenCalled();
    expect(gateway.eventLog).toEqual([]);
  });

  it("ignores presence and event-log callbacks from superseded clients", () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(HELLO);
    const stale = current();

    gateway.connect();
    const active = current();
    active.opts.onHello?.({
      ...HELLO,
      snapshot: {
        presence: [
          {
            instanceId: active.instanceId,
            user: { id: "current-user", name: "Current user" },
          },
        ],
      },
    });

    stale.opts.onEvent?.({
      type: "event",
      event: "presence",
      payload: {
        presence: [
          {
            instanceId: active.instanceId,
            user: { id: "stale-user", name: "Stale user" },
          },
        ],
      },
      seq: 1,
      stateVersion: { presence: 1, health: 1 },
    });

    expect(gateway.snapshot.selfUser).toEqual({ id: "current-user", name: "Current user" });
    expect(gateway.eventLog).toEqual([]);

    active.opts.onEvent?.({
      type: "event",
      event: "presence",
      payload: {
        presence: [
          {
            instanceId: active.instanceId,
            user: { id: "current-user", name: "Updated current user" },
          },
        ],
      },
      seq: 2,
      stateVersion: { presence: 2, health: 1 },
    });

    expect(gateway.snapshot.selfUser).toEqual({
      id: "current-user",
      name: "Updated current user",
    });
    expect(gateway.eventLog).toHaveLength(1);
  });

  it("updates sender provenance when presence qualification alone changes", () => {
    const { gateway, current } = createStore();
    gateway.start();
    const user = { id: "same-id", name: "Person", avatarUrl: "/api/users/same-id/avatar" };
    current().opts.onHello?.({
      ...HELLO,
      snapshot: { presence: [{ instanceId: current().instanceId, user }] },
    });
    const identity = { type: "profile", id: user.id };
    for (const nextUser of [{ ...user, identity }, user, { ...user, identity }]) {
      current().opts.onEvent?.({
        type: "event",
        event: "presence",
        payload: { presence: [{ instanceId: current().instanceId, user: nextUser }] },
      });
      expect(gateway.snapshot.selfUser).toEqual(nextUser);
    }
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

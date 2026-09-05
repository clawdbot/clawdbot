// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import {
  createGatewayStoreTestStore as createStore,
  GATEWAY_STORE_TEST_HELLO as HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { loadSettings } from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";

function stubBuildReloadDocument(href = "http://127.0.0.1:18789/chat/main") {
  const replace = vi.fn<(url: string) => void>();
  const location = Object.assign(new URL(href), { replace });
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", { location });
  const probe = createDeferred<Response>();
  const fetchMock = vi.fn<typeof fetch>(() => probe.promise);
  vi.stubGlobal("fetch", fetchMock);
  return { replace, probe, fetchMock };
}

describe("createApplicationGateway authentication diagnostics", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    stubGatewayStoreTestGlobals();
    store = createStore();
  });

  afterEach(() => {
    store.gateway.stop();
    setAvatarGatewayOrigin(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function rejectStaleBuild() {
    store.current().opts.onClose?.({
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
  }

  it("preserves an unfinished browser handoff across a build recovery reload", async () => {
    const bootstrapToken = "synthetic-owner-bootstrap";
    const initialUrl = new URL(
      `http://127.0.0.1:18789/settings/appearance?keep=yes#tab=keep&bootstrapToken=${bootstrapToken}&bootstrapProfile=owner`,
    );
    const startup = resolveApplicationStartupSettings(loadSettings(), initialUrl);
    expect(startup.location.hash).toBe("#tab=keep");
    const { pathname, search, hash } = startup.location;
    const { replace, probe, fetchMock } = stubBuildReloadDocument(
      new URL(`${pathname}${search}${hash}`, initialUrl).href,
    );
    store.gateway.connect({
      bootstrapToken: startup.pendingBootstrapToken ?? "",
      bootstrapProfile: startup.pendingBootstrapProfile ?? undefined,
    });
    rejectStaleBuild();
    expect(store.gateway.snapshot.phase).toBe("reload-required");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("HEAD");
    probe.resolve(new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    const destination = new URL(replace.mock.calls[0]![0]);
    const resumed = resolveApplicationStartupSettings(loadSettings(), destination);
    expect(resumed.pendingBootstrapToken).toBe(bootstrapToken);
    expect(resumed.pendingBootstrapProfile).toBe("owner");
    expect(resumed.location.pathname).toBe("/settings/appearance");
    expect(new URLSearchParams(resumed.location.search).get("keep")).toBe("yes");
    expect(resumed.location.hash).toBe("#tab=keep");
    expect(resumed.settings.token).toBe("");
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index++) {
        expect(storage.getItem(storage.key(index)!)).not.toContain(bootstrapToken);
      }
    }
  });

  it("lets the replacement handoff join the pending document probe for the same build", async () => {
    const { replace, probe, fetchMock } = stubBuildReloadDocument();
    const { gateway } = store;
    gateway.connect({ bootstrapToken: "retired-bootstrap" });
    rejectStaleBuild();
    gateway.connect({ bootstrapToken: "replacement-bootstrap", bootstrapProfile: "owner" });
    rejectStaleBuild();
    expect(fetchMock).toHaveBeenCalledOnce();

    probe.resolve(new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    const resumed = resolveApplicationStartupSettings(
      loadSettings(),
      new URL(replace.mock.calls[0]![0]),
    );
    expect(resumed.pendingBootstrapToken).toBe("replacement-bootstrap");
    expect(resumed.pendingBootstrapProfile).toBe("owner");
  });

  it.each(["stop", "reconnect", "credential", "retarget"] as const)(
    "does not finish retired handoff recovery after %s during the document probe",
    async (action) => {
      const { replace, probe, fetchMock } = stubBuildReloadDocument();
      const { gateway } = store;
      gateway.connect({ bootstrapToken: "synthetic-owner-bootstrap", bootstrapProfile: "owner" });
      rejectStaleBuild();
      expect(fetchMock).toHaveBeenCalledOnce();

      if (action === "stop") {
        gateway.stop();
      } else if (action === "reconnect") {
        gateway.connect();
      } else if (action === "credential") {
        gateway.connect({ bootstrapToken: "replacement-bootstrap" });
      } else {
        gateway.connect({ gatewayUrl: "wss://other-gateway.example" });
      }
      probe.resolve(new Response(null, { status: 200 }));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(replace).not.toHaveBeenCalled();
      expect(sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId")).toBeNull();
    },
  );

  it.each(["", "synthetic-remote-bootstrap"])(
    "does not automatically reload for a remote Gateway (bootstrap: %s)",
    async (bootstrapToken) => {
      const { replace, probe, fetchMock } = stubBuildReloadDocument();
      store.gateway.connect({
        gatewayUrl: "wss://other-gateway.example",
        bootstrapToken,
        bootstrapProfile: "owner",
      });
      rejectStaleBuild();
      probe.resolve(new Response(null, { status: 200 }));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(replace).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.gateway.snapshot.phase).toBe("reload-required");
    },
  );

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
    const { gateway, current } = store;
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

  it.each([
    {
      name: "missing user",
      authReason: "trusted_proxy_user_missing",
      expected: "trusted_proxy_user_missing",
    },
    {
      name: "attribution",
      authReason: "proxy_attribution_required",
      expected: "proxy_attribution_required",
    },
    { name: "unknown reason", authReason: "trusted_proxy_unknown", expected: null },
    { name: "oversized reason", authReason: "unrecognized".repeat(1_000), expected: null },
    {
      name: "non-string reason",
      authReason: { reason: "trusted_proxy_user_missing" },
      expected: null,
    },
    { name: "absent reason", authReason: undefined, expected: null },
  ])("projects only recognized auth reasons: $name", ({ authReason, expected }) => {
    const { gateway, current } = store;
    gateway.start();
    current().opts.onClose?.({
      code: 1008,
      reason: "unauthorized",
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: ConnectErrorDetailCodes.AUTH_UNAUTHORIZED, authReason },
      },
      willRetry: false,
    });
    expect(gateway.snapshot.lastErrorAuthReason).toBe(expected);
  });

  it("keeps proxy rejection reasons scoped to the current failed connection", () => {
    const { gateway, current } = store;
    gateway.start();
    const rejection = {
      code: 1008,
      reason: "unauthorized",
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: {
          code: ConnectErrorDetailCodes.AUTH_UNAUTHORIZED,
          authReason: "trusted_proxy_user_not_allowed",
        },
      },
      willRetry: false,
    };
    current().opts.onClose?.(rejection);
    expect(gateway.snapshot.lastErrorAuthReason).toBe("trusted_proxy_user_not_allowed");

    const stale = current();
    gateway.connect();
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
    stale.opts.onClose?.(rejection);
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();

    current().opts.onClose?.(rejection);
    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
    current().opts.onClose?.(rejection);
    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
    current().opts.onClose?.(rejection);
    gateway.stop();
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
  });

  it("preserves an outer code when a transport failure has no structured detail", () => {
    const { gateway, current } = store;
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
});

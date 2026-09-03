// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import {
  createGatewayStoreTestStore as createStore,
  GATEWAY_STORE_TEST_HELLO as HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";

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

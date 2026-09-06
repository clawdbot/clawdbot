// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { resolveGatewayCredentialsForUrlEdit } from "../app/settings.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  resolveAuthHintKind,
  resolvePairingHint,
  shouldShowInsecureContextHint,
} from "./connection-hints.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveGatewayCredentialsForUrlEdit", () => {
  it("preserves credentials for same normalized gateway endpoint edits", () => {
    expect(
      resolveGatewayCredentialsForUrlEdit(
        "wss://gateway.example/openclaw",
        " wss://gateway.example/openclaw/ ",
        { token: "abc123", password: "secret" },
      ),
    ).toEqual({ token: "abc123", password: "secret" });
  });

  it("loads a scoped token and clears the password when the gateway endpoint changes", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    sessionStorage.setItem(
      "openclaw.control.token.v1:wss://other-gateway.example/openclaw",
      "other-token",
    );

    expect(
      resolveGatewayCredentialsForUrlEdit(
        "wss://gateway.example/openclaw",
        "wss://other-gateway.example/openclaw/",
        { token: "abc123", password: "secret" },
      ),
    ).toEqual({ token: "other-token", password: "" });
  });

  it("clears credentials when the changed gateway endpoint has no scoped token", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());

    expect(
      resolveGatewayCredentialsForUrlEdit(
        "wss://gateway.example/openclaw",
        "wss://other-gateway.example/openclaw",
        { token: "abc123", password: "secret" },
      ),
    ).toEqual({ token: "", password: "" });
  });

  it("preserves the token but clears the password when only the query scope changes", () => {
    expect(
      resolveGatewayCredentialsForUrlEdit(
        "wss://gateway.example/openclaw?tenant=first",
        "wss://gateway.example/openclaw?tenant=second",
        { token: "abc123", password: "secret" },
      ),
    ).toEqual({ token: "abc123", password: "" });
  });

  it("does not restore legacy durable tokens when the gateway endpoint changes", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://other-gateway.example/openclaw",
        token: "gateway-token",
      }),
    );

    expect(
      resolveGatewayCredentialsForUrlEdit(
        "wss://gateway.example/openclaw",
        "wss://other-gateway.example/openclaw",
        { token: "abc123", password: "secret" },
      ),
    ).toEqual({ token: "", password: "" });
  });
});

describe("resolvePairingHint", () => {
  it.each([
    ["close reason", "disconnected (1008): pairing required", undefined],
    ["case-insensitive close reason", "Pairing Required", undefined],
    [
      "structured pairing code",
      "disconnected (4008): connect failed",
      ConnectErrorDetailCodes.PAIRING_REQUIRED,
    ],
  ])("detects pairing required from %s", (_name, lastError, lastErrorCode) => {
    expect(resolvePairingHint(false, lastError, lastErrorCode)).toEqual({
      kind: "pairing-required",
      requestId: null,
    });
  });

  it.each([
    ["connected clients", true, "disconnected (1008): pairing required"],
    ["missing errors", false, null],
    ["unrelated errors", false, "disconnected (1006): no reason"],
    ["auth errors", false, "disconnected (4008): unauthorized"],
  ])("ignores %s", (_name, connected, lastError) => {
    expect(resolvePairingHint(connected, lastError)).toBeNull();
  });

  it("detects scope-upgrade pending approval and keeps the request id", () => {
    expect(
      resolvePairingHint(
        false,
        "scope upgrade pending approval (requestId: req-123)",
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      ),
    ).toEqual({
      kind: "scope-upgrade-pending",
      requestId: "req-123",
    });
  });
});

describe("resolveAuthHintKind", () => {
  it("returns required for structured auth-required codes", () => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError: "disconnected (4008): connect failed",
        lastErrorCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
        hasToken: false,
        hasPassword: false,
      }),
    ).toBe("required");
  });

  it.each([
    { lastErrorCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH, hasToken: true },
    { lastErrorCode: ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID, hasToken: false },
  ])("returns failed for structured auth code $lastErrorCode", ({ lastErrorCode, hasToken }) => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError: "disconnected (4008): connect failed",
        lastErrorCode,
        hasToken,
        hasPassword: false,
      }),
    ).toBe("failed");
  });

  it.each([
    ["empty credentials", false, false, "unauthorized"],
    ["token", true, false, "connect failed"],
    ["password", false, true, "unauthorized"],
    ["both credentials", true, true, "connect failed"],
  ])("uses the identity-header code with %s", (_name, hasToken, hasPassword, lastError) => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError,
        lastErrorCode: ConnectErrorDetailCodes.AUTH_IDENTITY_HEADER_REQUIRED,
        hasToken,
        hasPassword,
      }),
    ).toBe("trusted-proxy");
  });

  it.each([
    ["connected clients", true, "unauthorized"],
    ["missing errors", false, null],
    ["empty errors", false, ""],
  ])("ignores the identity-header code for %s", (_name, connected, lastError) => {
    expect(
      resolveAuthHintKind({
        connected,
        lastError,
        lastErrorCode: ConnectErrorDetailCodes.AUTH_IDENTITY_HEADER_REQUIRED,
        hasToken: false,
        hasPassword: false,
      }),
    ).toBeNull();
  });

  it.each([ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED, "UNKNOWN_CONNECT_ERROR"])(
    "does not infer auth from unauthorized when the structured code is %s",
    (lastErrorCode) => {
      expect(
        resolveAuthHintKind({
          connected: false,
          lastError: "unauthorized",
          lastErrorCode,
          hasToken: true,
          hasPassword: false,
        }),
      ).toBeNull();
    },
  );

  it.each([
    "trusted_proxy_no_request",
    "trusted_proxy_untrusted_source",
    "trusted_proxy_loopback_source",
    "trusted_proxy_local_interface_check_failed",
    "trusted_proxy_local_interface_source",
    "trusted_proxy_user_missing",
    "trusted_proxy_user_not_allowed",
    "trusted_proxy_config_missing",
    "trusted_proxy_no_proxies_configured",
    "proxy_attribution_required",
  ])("classifies the structured proxy denial %s without token advice", (lastErrorAuthReason) => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError: "unauthorized",
        lastErrorCode: ConnectErrorDetailCodes.AUTH_UNAUTHORIZED,
        lastErrorAuthReason,
        hasToken: true,
        hasPassword: true,
      }),
    ).toBe("trusted-proxy");
  });

  it.each([undefined, "unknown", "trusted_proxy_unknown"])(
    "does not infer proxy authentication from an unrecognized reason %s",
    (lastErrorAuthReason) => {
      expect(
        resolveAuthHintKind({
          connected: false,
          lastError: "unauthorized: trusted_proxy_user_missing",
          lastErrorCode: ConnectErrorDetailCodes.AUTH_UNAUTHORIZED,
          lastErrorAuthReason,
          hasToken: false,
          hasPassword: false,
        }),
      ).toBe("failed");
    },
  );

  it("falls back to unauthorized string matching without structured codes", () => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError: "disconnected (4008): unauthorized",
        lastErrorCode: null,
        hasToken: true,
        hasPassword: false,
      }),
    ).toBe("failed");
  });
});

describe("shouldShowInsecureContextHint", () => {
  it("returns true for browser WebSocket security errors", () => {
    expect(
      shouldShowInsecureContextHint(
        false,
        "Browser refused the Gateway WebSocket for security reasons.",
        "BROWSER_WEBSOCKET_SECURITY_ERROR",
      ),
    ).toBe(true);
  });

  it("does not treat generic WebSocket constructor errors as insecure context", () => {
    expect(
      shouldShowInsecureContextHint(
        false,
        "Could not create the Gateway WebSocket: constructor failed",
        "BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR",
      ),
    ).toBe(false);
  });
});

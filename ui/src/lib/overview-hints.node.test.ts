// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { resolveGatewayTokenForUrlEdit } from "../app/settings.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  resolveAuthHintKind,
  resolvePairingHint,
  shouldShowInsecureContextHint,
} from "./overview-hints.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveGatewayTokenForUrlEdit", () => {
  it("preserves the current token for same normalized gateway endpoint edits", () => {
    expect(
      resolveGatewayTokenForUrlEdit(
        "wss://gateway.example/openclaw",
        " wss://gateway.example/openclaw/ ",
        "abc123",
      ),
    ).toBe("abc123");
  });

  it("loads a scoped token when the normalized gateway endpoint changes", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    sessionStorage.setItem(
      "openclaw.control.token.v1:wss://other-gateway.example/openclaw",
      "other-token",
    );

    expect(
      resolveGatewayTokenForUrlEdit(
        "wss://gateway.example/openclaw",
        "wss://other-gateway.example/openclaw/",
        "abc123",
      ),
    ).toBe("other-token");
  });

  it("clears the token when the changed gateway endpoint has no scoped token", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());

    expect(
      resolveGatewayTokenForUrlEdit(
        "wss://gateway.example/openclaw",
        "wss://other-gateway.example/openclaw",
        "abc123",
      ),
    ).toBe("");
  });

  it("does not restore legacy durable tokens when the gateway endpoint changes", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: "wss://other-gateway.example/openclaw",
        token: "legacy-durable-token",
      }),
    );

    expect(
      resolveGatewayTokenForUrlEdit(
        "wss://gateway.example/openclaw",
        "wss://other-gateway.example/openclaw",
        "abc123",
      ),
    ).toBe("");
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

  it("returns failed for structured auth mismatch codes", () => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError: "disconnected (4008): connect failed",
        lastErrorCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
        hasToken: true,
        hasPassword: false,
      }),
    ).toBe("failed");
  });

  it("does not treat generic connect failures as auth failures", () => {
    expect(
      resolveAuthHintKind({
        connected: false,
        lastError: "disconnected (4008): connect failed",
        lastErrorCode: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
        hasToken: true,
        hasPassword: false,
      }),
    ).toBeNull();
  });

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

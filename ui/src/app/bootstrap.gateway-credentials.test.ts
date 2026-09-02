/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { persistSessionToken } from "./settings.ts";

const NATIVE_AUTH_KEY = "__OPENCLAW_NATIVE_CONTROL_AUTH__";
const originalUrl = window.location.href;
let runtime: ApplicationRuntime | undefined;

function setNativeAuth(auth: { gatewayUrl: string; token?: string; password?: string }) {
  window[NATIVE_AUTH_KEY] = auth;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  runtime?.stop();
  runtime = undefined;
  window.history.replaceState({}, "", originalUrl);
  vi.unstubAllGlobals();
});

describe("pending Gateway credentials", () => {
  it("re-scopes credentials before confirming a changed Gateway URL", () => {
    const currentGatewayUrl = "wss://gateway.example/openclaw";
    const nextGatewayUrl = "wss://other-gateway.example/openclaw";
    persistSessionToken(nextGatewayUrl, "next-token");
    setNativeAuth({
      gatewayUrl: currentGatewayUrl,
      token: "old-token",
      password: "old-password",
    });
    window.history.replaceState({}, "", `/#gatewayUrl=${encodeURIComponent(nextGatewayUrl)}`);
    runtime = bootstrapApplication({ sessionPathBuilderReady: new Promise<void>(() => {}) });

    runtime.confirmPendingGatewayConnection();

    expect(runtime.context.gateway.connection.gatewayUrl).toBe(nextGatewayUrl);
    expect(runtime.context.gateway.connection.token).toBe("next-token");
    expect(runtime.context.gateway.connection.password).toBe("");
    persistSessionToken(nextGatewayUrl, "");
  });

  it("holds a bootstrap token until its changed Gateway URL is confirmed", () => {
    const currentGatewayUrl = "wss://gateway.example/openclaw";
    const nextGatewayUrl = "wss://other-gateway.example/openclaw";
    setNativeAuth({ gatewayUrl: currentGatewayUrl });
    window.history.replaceState(
      {},
      "",
      `/#gatewayUrl=${encodeURIComponent(nextGatewayUrl)}&bootstrapToken=next-bootstrap`,
    );
    runtime = bootstrapApplication({ sessionPathBuilderReady: new Promise<void>(() => {}) });

    expect(runtime.context.gateway.connection.bootstrapToken).toBe("");

    runtime.confirmPendingGatewayConnection();

    expect(runtime.context.gateway.connection.gatewayUrl).toBe(nextGatewayUrl);
    expect(runtime.context.gateway.connection.bootstrapToken).toBe("next-bootstrap");
  });
});

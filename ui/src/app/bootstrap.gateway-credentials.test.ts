/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"https://gateway.example/"} */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import * as gatewayStore from "./gateway-store.ts";
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
  delete window[NATIVE_AUTH_KEY];
  window.history.replaceState({}, "", originalUrl);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pending Gateway credentials", () => {
  it("recovers a bare dashboard login through its same-origin handoff without changing the route", async () => {
    window.history.replaceState({}, "", "/settings/appearance?keep=yes#section");
    const initialUrl = window.location.href;
    const store = createGatewayStoreTestStore();
    vi.spyOn(gatewayStore, "createApplicationGateway").mockReturnValue(store.gateway);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ bootstrapToken: "owner-bootstrap", bootstrapProfile: "owner" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    runtime = bootstrapApplication();
    vi.spyOn(runtime.router, "start").mockResolvedValue(undefined);
    await runtime.start();
    expect(fetchMock).not.toHaveBeenCalled();

    store.current().opts.onClose?.({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "token missing",
        details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
      },
      willRetry: false,
    });

    await vi.waitFor(() => expect(store.gateway.connection.bootstrapToken).toBe("owner-bootstrap"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/.well-known/openclaw/browser-bootstrap",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      }),
    );
    expect(store.current().opts.bootstrapProfile).toBe("owner");
    expect(window.location.href).toBe(initialUrl);
  });

  it.each(["native client", "unconfirmed Gateway"])(
    "does not replace the %s authentication flow with a browser handoff",
    async (flow) => {
      window.history.replaceState({}, "", "/settings/appearance");
      const store = createGatewayStoreTestStore();
      vi.spyOn(gatewayStore, "createApplicationGateway").mockReturnValue(store.gateway);
      if (flow === "native client") {
        window[NATIVE_AUTH_KEY] = {
          gatewayUrl: store.gateway.connection.gatewayUrl,
          client: {
            id: "openclaw-ios",
            mode: "ui",
            platform: "iOS 27.0.0",
            deviceFamily: "iPhone",
            scopes: ["operator.read"],
          },
        };
      } else {
        window.history.replaceState(
          {},
          "",
          "/settings/appearance?gatewayUrl=wss%3A%2F%2Fother-gateway.example",
        );
      }
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json({ bootstrapToken: "owner-bootstrap", bootstrapProfile: "owner" }),
      );
      vi.stubGlobal("fetch", fetchMock);
      runtime = bootstrapApplication();
      vi.spyOn(runtime.router, "start").mockResolvedValue(undefined);
      await runtime.start();
      store.current().opts.onClose?.({
        code: 4008,
        reason: "connect failed",
        error: {
          code: "INVALID_REQUEST",
          message: "token missing",
          details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
        },
        willRetry: false,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.clients).toHaveLength(1);
    },
  );

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
    runtime = bootstrapApplication();

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
    runtime = bootstrapApplication();

    expect(runtime.context.gateway.connection.bootstrapToken).toBe("");

    runtime.confirmPendingGatewayConnection();

    expect(runtime.context.gateway.connection.gatewayUrl).toBe(nextGatewayUrl);
    expect(runtime.context.gateway.connection.bootstrapToken).toBe("next-bootstrap");
  });
});

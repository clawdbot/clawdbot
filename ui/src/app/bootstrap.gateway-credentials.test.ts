/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"https://gateway.example/"} */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import * as gatewayStore from "./gateway-store.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

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
  it.each([
    {
      name: "an initial missing token",
      authCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
      retryUnavailable: false,
    },
    {
      name: "a missing token after retrying an unavailable Gateway",
      authCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
      retryUnavailable: true,
    },
    {
      name: "a missing password after retrying an unavailable Gateway",
      authCode: ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
      retryUnavailable: true,
    },
  ])(
    "recovers $name through its same-origin handoff without changing the route",
    async ({ authCode, retryUnavailable }) => {
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

      if (retryUnavailable) {
        const revision = store.gateway.connectionRevision;
        store.current().opts.onClose?.({
          code: 4008,
          reason: "connect failed",
          error: { code: "UNAVAILABLE", message: "Gateway temporarily unavailable" },
          willRetry: false,
        });
        expect(store.gateway.snapshot).toMatchObject({
          phase: "stopped",
          lastErrorCode: "UNAVAILABLE",
        });
        expect(fetchMock).not.toHaveBeenCalled();

        store.gateway.connect();
        expect(store.gateway.connectionRevision).toBe(revision);
      }

      store.current().opts.onClose?.({
        code: 4008,
        reason: "connect failed",
        error: {
          code: "INVALID_REQUEST",
          message: "authentication missing",
          details: { code: authCode },
        },
        willRetry: false,
      });

      await vi.waitFor(() =>
        expect(store.gateway.connection.bootstrapToken).toBe("owner-bootstrap"),
      );
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
    },
  );

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

  it("uses paired-device credentials while other connection bootstrap work is pending", async () => {
    const gatewayUrl = "ws://localhost";
    setNativeAuth({ gatewayUrl });
    window.history.replaceState({}, "", "/settings/appearance");
    const store = createGatewayStoreTestStore({
      settings: { ...loadSettings(), gatewayUrl, token: "" },
    });
    vi.spyOn(gatewayStore, "createApplicationGateway").mockReturnValue(store.gateway);
    const pending = createDeferred();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (new Headers(init?.headers).get("Authorization") !== "Bearer fixture-device-token") {
        return new Response(null, { status: 401 });
      }
      return new Response(
        JSON.stringify({
          serverVersion: "paired",
          pluginAssetsRequireAuth: true,
          pluginFrameGrants: [
            {
              pluginId: "fixture",
              path: "/__openclaw__/plugins/control-ui/fixture/",
              match: "prefix",
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    runtime = bootstrapApplication();
    runtime.context.gateway.start();
    const client = store.current();
    client.request.mockImplementation(async (method) => {
      if (method === "update.status" || method === "exec.approval.list") {
        await pending.promise;
      }
      return {};
    });

    try {
      client.opts.onHello?.({
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"], deviceToken: "fixture-device-token" },
      });
      await vi.waitFor(() => {
        const methods = client.request.mock.calls.map(([method]) => method);
        expect(methods).toContain("update.status");
        expect(methods).toContain("exec.approval.list");
      });
      expect(fetchMock).not.toHaveBeenCalled();

      // Native plugin activation requests its grant before unrelated queued
      // startup RPCs finish; the connected Gateway already owns its credential.
      await expect(runtime.context.config.refresh()).resolves.toMatchObject({
        serverVersion: "paired",
        pluginFrameGrants: [{ pluginId: "fixture" }],
      });
    } finally {
      runtime.stop();
      pending.resolve();
    }
  });
});

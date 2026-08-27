import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { openPluginTalkSession } from "./talk-plugin-session.js";

function openScopedSession(context: GatewayRequestContext, sessionKey: string) {
  const client = {
    connId: "plugin-http:127.0.0.1",
    connect: {
      role: "operator",
      scopes: ["operator.talk"],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as unknown as NonNullable<GatewayRequestOptions["client"]>;
  return withPluginRuntimeGatewayRequestScope(
    {
      client,
      context,
      gatewayMethodDispatchAllowed: true,
      routeSignal: new AbortController().signal,
      isWebchatConnect: () => false,
      pluginId: "avatar",
    },
    async () =>
      await openPluginTalkSession({
        sessionKey,
        signal: new AbortController().signal,
        onEvent: vi.fn(),
      }),
  );
}

beforeEach(() => resetGatewayWorkAdmission());
afterEach(() => resetGatewayWorkAdmission());

describe("plugin Talk session Gateway admission", () => {
  it("rejects session creation while the Gateway is suspended", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    try {
      await expect(
        openScopedSession(
          {
            getRuntimeConfig: () => ({}),
            logGateway: { warn: vi.fn() },
          } as unknown as GatewayRequestContext,
          "agent:main:main",
        ),
      ).rejects.toThrow("talk.session.create unavailable during gateway suspension");
    } finally {
      suspension?.rollback();
    }
  });

  it("rejects a session owned by an unknown agent", async () => {
    const context = {
      getRuntimeConfig: () => ({
        agents: { entries: { main: {} } },
        session: { scope: "global" },
      }),
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(openScopedSession(context, "agent:ghost:main")).rejects.toThrow(
      'Unknown agent id "ghost"',
    );
  });
});

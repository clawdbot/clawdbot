import { describe, expect, it, vi } from "vitest";
import { callGatewayFromCli, isGatewayClientRequestError } from "../plugin-sdk/gateway-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginGatewayMethodDescriptor } from "./methods/registry.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  setTestPluginRegistry,
  startTestGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway-routed plugin CLI calls", () => {
  it("routes voicecall status with token auth and preserves wrong-token request errors", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ params, respond }) => {
      respond(true, { found: true, call: { callId: params?.callId, state: "active" } });
    });
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["voicecall.status"] = handler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "voice-call",
        name: "voicecall.status",
        handler,
        scope: "operator.read",
      }),
    );
    setTestPluginRegistry(registry);

    const port = await getGatewayTestPort();
    const token = "voice-call-cli-routing-token";
    const url = `ws://127.0.0.1:${port}`;
    const server = await startTestGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });
    try {
      await expect(
        callGatewayFromCli(
          "voicecall.status",
          { url, token, json: true, timeout: "5000" },
          { callId: "call-1" },
          { progress: false },
        ),
      ).resolves.toEqual({
        found: true,
        call: { callId: "call-1", state: "active" },
      });
      expect(handler).toHaveBeenCalledOnce();

      let wrongTokenError: unknown;
      await callGatewayFromCli(
        "voicecall.status",
        { url, token: "wrong-token", json: true, timeout: "5000" },
        { callId: "call-1" },
        { progress: false },
      ).catch((error: unknown) => {
        wrongTokenError = error;
      });

      expect(isGatewayClientRequestError(wrongTokenError)).toBe(true);
      expect(wrongTokenError).toMatchObject({
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
        details: { code: "AUTH_TOKEN_MISMATCH" },
        retryable: false,
      });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await server.close({ reason: "voice-call CLI routing test complete" });
    }
  }, 30_000);
});

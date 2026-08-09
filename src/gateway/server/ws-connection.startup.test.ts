/**
 * WebSocket connection startup regression tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_STARTUP_CLOSE_CODE,
  GATEWAY_STARTUP_CLOSE_REASON,
  GATEWAY_STARTUP_PENDING_CLOSE_CAUSE,
  GATEWAY_STARTUP_UNAVAILABLE_REASON,
} from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import {
  attachGatewayWsForTest,
  createGatewayWsTestLogger,
  createGatewayWsTestRequestContext,
  createGatewayWsTestSocket,
} from "./ws-connection.test-helpers.js";

describe("attachGatewayWsConnectionHandler startup readiness", () => {
  it("admits only one of two connect frames that race during lazy handler loading", async () => {
    const sent: unknown[] = [];
    const clients = new Set<unknown>();
    const socket = createGatewayWsTestSocket({
      onSend: (data) => {
        sent.push(JSON.parse(data));
      },
    });

    attachGatewayWsForTest({
      attach: attachGatewayWsConnectionHandler,
      clients,
      socket,
      options: {
        resolvedAuth: { mode: "token", allowTailscale: false, token: "test-token" },
        buildRequestContext: () => createGatewayWsTestRequestContext() as never,
      },
    });
    const connectFrame = (id: string) =>
      JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "gateway-client",
            version: "dev",
            platform: "test",
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          role: "operator",
          scopes: [],
          caps: [],
          auth: { token: "test-token" },
        },
      });

    socket.emit("message", connectFrame("connect-1"));
    socket.emit("message", connectFrame("connect-2"));
    await vi.dynamicImportSettled();

    await vi.waitFor(() => {
      expect(clients.size).toBe(1);
      expect(
        sent.filter(
          (frame) =>
            typeof frame === "object" &&
            frame !== null &&
            (frame as { type?: unknown; ok?: unknown }).type === "res" &&
            (frame as { ok?: unknown }).ok === true,
        ),
      ).toHaveLength(1);
    });

    socket.emit("close", 1000, Buffer.from("done"));
    expect(clients.size).toBe(0);
  });

  it.each([GATEWAY_STARTUP_CLOSE_CODE, 1006])(
    "keeps startup-unavailable close code %i at debug level",
    async (observedCloseCode) => {
      const responseReceived = createDeferred<{
        type?: unknown;
        id?: unknown;
        ok?: unknown;
        error?: {
          code?: unknown;
          retryable?: unknown;
          retryAfterMs?: unknown;
          details?: unknown;
        };
      }>();
      const socket = createGatewayWsTestSocket({
        onSend: (data) => {
          const frame = JSON.parse(data) as unknown;
          if (
            typeof frame === "object" &&
            frame !== null &&
            (frame as { type?: unknown }).type === "res" &&
            (frame as { id?: unknown }).id === "connect-1"
          ) {
            responseReceived.resolve(frame);
          }
        },
      });
      const logWsControl = createGatewayWsTestLogger();

      attachGatewayWsForTest({
        attach: attachGatewayWsConnectionHandler,
        socket,
        options: {
          resolvedAuth: { mode: "none", allowTailscale: false },
          isStartupPending: () => true,
          logWsControl: logWsControl as never,
          buildRequestContext: () => createGatewayWsTestRequestContext() as never,
        },
      });
      socket.emit(
        "message",
        JSON.stringify({
          type: "req",
          id: "connect-1",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: GATEWAY_CLIENT_NAMES.CLI,
              version: "dev",
              platform: "test",
              mode: GATEWAY_CLIENT_MODES.CLI,
            },
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
          },
        }),
      );

      // The handler is lazy-loaded; wait for its actual frame instead of a one-second poll.
      const response = await responseReceived.promise;
      expect(response?.type).toBe("res");
      expect(response?.id).toBe("connect-1");
      expect(response?.ok).toBe(false);
      expect(response?.error?.code).toBe("UNAVAILABLE");
      expect(response?.error?.retryable).toBe(true);
      expect(response?.error?.retryAfterMs).toBe(500);
      expect(response?.error?.details).toEqual({ reason: GATEWAY_STARTUP_UNAVAILABLE_REASON });
      await vi.waitFor(() => {
        expect(socket.close).toHaveBeenCalledWith(
          GATEWAY_STARTUP_CLOSE_CODE,
          GATEWAY_STARTUP_CLOSE_REASON,
        );
      });
      socket.emit("close", observedCloseCode, Buffer.alloc(0));
      expect(logWsControl.debug).toHaveBeenCalledWith(
        expect.stringContaining("closed before connect"),
        expect.objectContaining({
          cause: GATEWAY_STARTUP_PENDING_CLOSE_CAUSE,
          handshake: "failed",
        }),
      );
      expect(logWsControl.debug).toHaveBeenCalledWith(
        expect.stringContaining(`code=${observedCloseCode}`),
        expect.anything(),
      );
      expect(logWsControl.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("closed before connect"),
        expect.anything(),
      );
    },
  );
});

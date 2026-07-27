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
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import {
  attachGatewayWsForTest,
  createGatewayWsTestLogger,
  createGatewayWsTestRequestContext,
  createGatewayWsTestSocket,
} from "./ws-connection.test-helpers.js";

describe("attachGatewayWsConnectionHandler startup readiness", () => {
  it.each([GATEWAY_STARTUP_CLOSE_CODE, 1006])(
    "keeps startup-unavailable close code %i at debug level",
    async (observedCloseCode) => {
      const sent: unknown[] = [];
      const socket = createGatewayWsTestSocket({
        onSend: (data) => {
          sent.push(JSON.parse(data));
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

      await vi.waitFor(() => {
        expect(
          sent.some(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              (frame as { type?: unknown; id?: unknown; ok?: unknown }).type === "res" &&
              (frame as { id?: unknown }).id === "connect-1",
          ),
        ).toBe(true);
      });

      const response = sent.find(
        (frame) =>
          typeof frame === "object" &&
          frame !== null &&
          (frame as { type?: unknown; id?: unknown }).type === "res" &&
          (frame as { id?: unknown }).id === "connect-1",
      ) as
        | {
            type?: unknown;
            id?: unknown;
            ok?: unknown;
            error?: {
              code?: unknown;
              retryable?: unknown;
              retryAfterMs?: unknown;
              details?: unknown;
            };
          }
        | undefined;
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

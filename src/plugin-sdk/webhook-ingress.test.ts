import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveRequestClientIp } from "./webhook-ingress.js";

function request(): IncomingMessage {
  return {
    headers: { "x-forwarded-for": "192.0.2.99" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("resolveRequestClientIp", () => {
  it("prefers Gateway-validated attribution over raw proxy headers", () => {
    const clientIp = withPluginRuntimeGatewayRequestScope(
      {
        client: { clientIp: "198.51.100.42" } as never,
        isWebchatConnect: () => false,
      },
      () => resolveRequestClientIp(request(), ["127.0.0.1"]),
    );

    expect(clientIp).toBe("198.51.100.42");
  });

  it("retains configured-proxy resolution outside Gateway request scope", () => {
    expect(resolveRequestClientIp(request(), ["127.0.0.1"])).toBe("192.0.2.99");
  });
});

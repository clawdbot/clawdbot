import { describe, expect, it, vi } from "vitest";
import { disconnectDisallowedGatewayBrowserOriginClients } from "./ws-origin-policy.js";

describe("committed browser origin policy", () => {
  it.each(["allowedOrigins", "dangerouslyAllowHostHeaderOriginFallback"] as const)(
    "retires only clients no longer admitted after %s changes",
    (policy) => {
      const revoked = {
        browserOrigin: {
          origin: "https://revoked.example.test",
          requestHost: "revoked.example.test",
          isLocalClient: false,
        },
        invalidated: false,
        invalidatedReason: undefined as string | undefined,
        socket: { close: vi.fn() },
      };
      const retained = {
        browserOrigin: {
          origin: "https://retained.example.test",
          requestHost: "gateway.example.test",
          isLocalClient: false,
        },
        socket: { close: vi.fn() },
      };
      const backend = { socket: { close: vi.fn() } };
      const clients = [revoked, retained, backend];
      disconnectDisallowedGatewayBrowserOriginClients(clients, {
        gateway: {
          controlUi: {
            allowedOrigins: [
              "https://retained.example.test",
              ...(policy === "allowedOrigins" ? ["https://revoked.example.test"] : []),
            ],
            dangerouslyAllowHostHeaderOriginFallback: policy !== "allowedOrigins",
          },
        },
      });
      expect(revoked.socket.close).not.toHaveBeenCalled();

      disconnectDisallowedGatewayBrowserOriginClients(clients, {
        gateway: { controlUi: { allowedOrigins: ["https://retained.example.test"] } },
      });
      expect(revoked.socket.close).toHaveBeenCalledExactlyOnceWith(1008, "origin not allowed");
      expect(revoked.invalidated).toBe(true);
      expect(revoked.invalidatedReason).toBe("origin-policy-changed");
      expect(retained.socket.close).not.toHaveBeenCalled();
      expect(backend.socket.close).not.toHaveBeenCalled();
    },
  );
});

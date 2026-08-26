import { describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

describe("trajectory authorization", () => {
  it("requires operator.read before dispatching detail reads", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
      respond(true, { ok: false, unavailableReason: "not_found" }),
    );
    const respond = vi.fn();

    await handleGatewayRequest({
      req: {
        type: "req",
        id: "req-trajectory-detail",
        method: "sessions.trajectory.detail",
        params: { sessionKey: "agent:main:main", recordId: "runtime:0" },
      },
      respond,
      client: {
        connId: "conn-trajectory-detail",
        connect: {
          role: "operator",
          scopes: ["operator.approvals"],
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
      extraHandlers: { "sessions.trajectory.detail": handler },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: "missing scope: operator.read",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.read",
        requiredScopes: ["operator.read"],
      },
    });
  });
});

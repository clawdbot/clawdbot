import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../gateway/client.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: callGatewayMock };
});

const { resolveSessionTarget } = await import("./session-target.js");

describe("session target connection errors", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("surfaces identity-proxy remediation without tailnet or SSH tunnel advice", async () => {
    callGatewayMock.mockRejectedValue(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "gateway rejected websocket upgrade (HTTP 302)",
        details: { reason: "websocket-upgrade-rejected", httpStatus: 302 },
      }),
    );

    let error: unknown;
    try {
      await resolveSessionTarget({ raw: "gateway.example/main/a1166b81" });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("gateway.remote.edgeAuth");
    expect(String(error)).not.toContain("tailnet");
    expect(String(error)).not.toContain("SSH tunnel");
  });
});

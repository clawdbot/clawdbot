import type { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { describe, expect, it, vi } from "vitest";
import { callGoogleMeetGateway } from "./cli-shared.js";

function gatewayTransportError(code?: number): Error {
  return Object.assign(new Error("gateway transport failed"), {
    name: "GatewayTransportError",
    kind: "closed",
    connectionDetails: { url: "ws://127.0.0.1:18789" },
    ...(code === undefined ? {} : { code }),
  });
}

function gatewayRequestError(message: string, gatewayCode = "INVALID_REQUEST"): Error {
  return Object.assign(new Error(message), {
    name: "GatewayClientRequestError",
    gatewayCode,
    retryable: false,
  });
}

function rejectingGateway(error: Error): typeof callGatewayFromCli {
  return vi.fn<typeof callGatewayFromCli>().mockRejectedValue(error);
}

describe("callGoogleMeetGateway local fallback", () => {
  it("returns a successful gateway payload", async () => {
    const payload = { found: true };
    const callGateway = vi.fn<typeof callGatewayFromCli>().mockResolvedValue(payload);

    await expect(
      callGoogleMeetGateway({ callGateway, method: "googlemeet.status" }),
    ).resolves.toEqual({ ok: true, payload });
  });

  it("falls back for an uncoded transport close", async () => {
    const error = gatewayTransportError();

    await expect(
      callGoogleMeetGateway({
        callGateway: rejectingGateway(error),
        method: "googlemeet.status",
      }),
    ).resolves.toEqual({ ok: false, error });
  });

  it.each([1006, 1000])("propagates a transport close with code %s", async (code) => {
    const error = gatewayTransportError(code);

    await expect(
      callGoogleMeetGateway({
        callGateway: rejectingGateway(error),
        method: "googlemeet.status",
      }),
    ).rejects.toBe(error);
  });

  it("propagates a transport timeout", async () => {
    const error = Object.assign(new Error("gateway timed out"), {
      name: "GatewayTransportError",
      kind: "timeout",
      connectionDetails: { url: "ws://127.0.0.1:18789" },
    });

    await expect(
      callGoogleMeetGateway({
        callGateway: rejectingGateway(error),
        method: "googlemeet.status",
      }),
    ).rejects.toBe(error);
  });

  it("falls back when the exact Meet method is not registered", async () => {
    const error = gatewayRequestError("unknown method: googlemeet.status");

    await expect(
      callGoogleMeetGateway({
        callGateway: rejectingGateway(error),
        method: "googlemeet.status",
      }),
    ).resolves.toEqual({ ok: false, error });
  });

  it.each([
    gatewayRequestError("unknown method: voicecall.status"),
    new Error("unknown method: googlemeet.status"),
    new Error("gateway not connected"),
    new Error("connect ECONNREFUSED 127.0.0.1:18789"),
  ])("propagates a non-fallback error: $message", async (error) => {
    await expect(
      callGoogleMeetGateway({
        callGateway: rejectingGateway(error),
        method: "googlemeet.status",
      }),
    ).rejects.toBe(error);
  });
});

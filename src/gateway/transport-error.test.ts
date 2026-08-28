import { describe, expect, it } from "vitest";
import { GatewayProtocolRequestTimeoutError } from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { GatewayTransportError, isGatewayRpcUnavailableError } from "./transport-error.js";

const connectionDetails = {
  url: "ws://127.0.0.1:18789",
  urlSource: "local loopback",
  message: "Gateway target: ws://127.0.0.1:18789",
};

describe("Gateway RPC transport availability", () => {
  it.each([
    {
      label: "typed connection close",
      error: new GatewayTransportError({
        kind: "closed",
        code: 1006,
        message: "gateway closed (1006 abnormal closure): unavailable",
        connectionDetails,
      }),
    },
    {
      label: "typed service restart",
      error: new GatewayTransportError({
        kind: "closed",
        code: 1012,
        message: "gateway closed (1012): service restart",
        connectionDetails,
      }),
    },
    {
      label: "typed socket failure without a close code",
      error: new GatewayTransportError({
        kind: "closed",
        message: "Gateway not reachable at ws://127.0.0.1:18789 (ECONNREFUSED).",
        connectionDetails,
      }),
    },
    {
      label: "typed connection timeout",
      error: new GatewayTransportError({
        kind: "timeout",
        timeoutMs: 1_500,
        message: "gateway timeout after 1500ms",
        connectionDetails,
      }),
    },
    {
      label: "pending-request abnormal closure",
      error: new Error("gateway closed (1006): abnormal closure"),
    },
    {
      label: "pending-request service restart",
      error: new Error("gateway closed (1012): service restart"),
    },
    { label: "pending-request timeout", error: new Error("gateway timeout after 1500ms") },
    {
      label: "pending-request timeout with connection details",
      error: new Error("gateway timeout after 1500ms\nGateway target: ws://127.0.0.1:18789"),
    },
  ])("recognizes $label as eligible for ownership-safe recovery", ({ error }) => {
    expect(isGatewayRpcUnavailableError(error)).toBe(true);
  });

  it.each([
    ...[1000, 1002, 1003, 1008, 1011, 4000, 4001, 4999].flatMap((code) => [
      {
        label: `typed authoritative close ${code}`,
        error: new GatewayTransportError({
          kind: "closed",
          code,
          message: `gateway closed (${code}): rejected`,
          connectionDetails,
        }),
      },
      {
        label: `plain authoritative close ${code}`,
        error: new Error(`gateway closed (${code}): rejected`),
      },
    ]),
    {
      label: "credentials required",
      error: Object.assign(new Error("gateway requires credentials"), {
        name: "GatewayCredentialsRequiredError",
      }),
    },
    {
      label: "authoritative request rejection",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "gateway closed (1006): request rejected",
      }),
    },
    {
      label: "already-dispatched request timeout",
      error: new GatewayProtocolRequestTimeoutError({
        method: "skills.proposals.inspect",
        timeoutMs: 1_500,
        requestSent: true,
      }),
    },
    { label: "arbitrary failure", error: new Error("gateway unavailable") },
    {
      label: "noncanonical close",
      error: new Error("gateway closed (1006 abnormal closure): down"),
    },
    { label: "noncanonical timeout", error: new Error("gateway timeout after 1500ms: rejected") },
    { label: "non-error transport-looking value", error: "gateway closed (1006): unavailable" },
  ])("rejects $label as a recovery signal", ({ error }) => {
    expect(isGatewayRpcUnavailableError(error)).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProtocolRequestTimeoutError } from "../../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCliWithTransport: vi.fn(),
}));

vi.mock("../gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: gatewayMocks.callGatewayFromCliWithTransport,
}));

import { resolveCliNode, resolveNodeDiagnosticsId } from "./rpc.js";

function requestError(params: {
  code?: string;
  message?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}) {
  return new GatewayClientRequestError({
    code: params.code ?? "INVALID_REQUEST",
    message: params.message ?? "unknown method: node.list",
    ...params,
  });
}

describe("node inventory resolution", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayFromCliWithTransport.mockReset();
  });

  it("uses paired records when an older Gateway rejects the exact node.list method", async () => {
    gatewayMocks.callGatewayFromCliWithTransport
      .mockRejectedValueOnce(requestError({}))
      .mockResolvedValueOnce({
        pending: [],
        paired: [{ nodeId: "legacy-node", displayName: "Legacy Node", platform: "ios" }],
      });

    await expect(resolveCliNode({}, "Legacy Node")).resolves.toMatchObject({
      nodeId: "legacy-node",
      displayName: "Legacy Node",
    });
    expect(
      gatewayMocks.callGatewayFromCliWithTransport.mock.calls.map(([method]) => method),
    ).toEqual(["node.list", "node.pair.list"]);
  });

  it.each([
    {
      label: "a local request timeout",
      error: new GatewayProtocolRequestTimeoutError({
        method: "node.list",
        timeoutMs: 80,
        requestSent: true,
      }),
    },
    {
      label: "an authorization rejection",
      error: requestError({ code: "UNAUTHORIZED", message: "operator authorization required" }),
    },
    {
      label: "an INVALID_REQUEST authentication failure",
      error: requestError({ message: "invalid auth token" }),
    },
    {
      label: "a retryable unknown-method rejection",
      error: requestError({ retryable: true }),
    },
    {
      label: "an unknown-method rejection for another method",
      error: requestError({ message: "unknown method: node.list.extra" }),
    },
    {
      label: "malformed request retry metadata",
      error: requestError({ retryAfterMs: -1 }),
    },
    {
      label: "an embedded unknown-method message",
      error: requestError({ message: "request failed: unknown method: node.list" }),
    },
    {
      label: "a network connection error",
      error: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18789"), {
        code: "ECONNREFUSED",
      }),
    },
    {
      label: "a closed Gateway transport",
      error: new Error("gateway closed (1006): connection lost"),
    },
    {
      label: "a malformed request-error lookalike",
      error: Object.assign(new Error("unknown method: node.list"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
    },
    {
      label: "a plain unknown-method error",
      error: new Error("unknown method: node.list"),
    },
  ])("preserves $label without consulting stale paired nodes", async ({ error }) => {
    gatewayMocks.callGatewayFromCliWithTransport
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        pending: [],
        paired: [{ nodeId: "stale-node", displayName: "Stale Node" }],
      });

    await expect(resolveCliNode({}, "Stale Node")).rejects.toBe(error);
    expect(
      gatewayMocks.callGatewayFromCliWithTransport.mock.calls.map(([method]) => method),
    ).toEqual(["node.list"]);
  });

  it.each([
    requestError({ retryable: true }),
    requestError({ message: "unknown method: node.list.extra" }),
    Object.assign(new Error("unknown method: node.list"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
    }),
  ])("keeps diagnostics on the same exact missing-method contract", async (error) => {
    gatewayMocks.callGatewayFromCliWithTransport.mockRejectedValueOnce(error);

    await expect(resolveNodeDiagnosticsId({}, "stale-node")).rejects.toBe(error);
    expect(
      gatewayMocks.callGatewayFromCliWithTransport.mock.calls.map(([method]) => method),
    ).toEqual(["node.list"]);
  });
});

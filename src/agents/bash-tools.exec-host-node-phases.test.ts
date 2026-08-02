import { describe, expect, it, vi } from "vitest";
import {
  formatNodeInvokeFailureFollowup,
  invokeNodeSystemRun,
} from "./bash-tools.exec-host-node-failure.js";

const callGatewayToolMock = vi.hoisted(() => vi.fn());

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
}));

function gatewayNodeInvokeError(params: {
  code?: string;
  message?: string;
  nodeCommandDispatched?: boolean;
  requestSent?: boolean;
}): Error {
  return Object.assign(new Error(params.message ?? "node invoke failed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "UNAVAILABLE",
    details: {
      nodeError: {
        ...(params.code ? { code: params.code } : {}),
        message: params.message ?? "node invoke failed",
      },
      ...(params.nodeCommandDispatched !== undefined
        ? { nodeCommandDispatched: params.nodeCommandDispatched }
        : {}),
    },
    ...(params.requestSent !== undefined ? { requestSent: params.requestSent } : {}),
  });
}

async function invokeFailure(error: unknown) {
  callGatewayToolMock.mockRejectedValueOnce(error);
  const result = await invokeNodeSystemRun({
    invokeWaitMs: 1_000,
    invoke: { nodeId: "node-1", command: "system.run" },
  });
  if (result.ok) {
    throw new Error("expected node invoke failure");
  }
  return result.failure;
}

describe("invokeNodeSystemRun failure classification", () => {
  it("classifies only proven pre-dispatch NOT_CONNECTED as retry-safe", async () => {
    await expect(
      invokeFailure(
        gatewayNodeInvokeError({
          code: "NOT_CONNECTED",
          message: "node not connected",
          nodeCommandDispatched: false,
          requestSent: true,
        }),
      ),
    ).resolves.toEqual({
      reason: "not-dispatched",
      retrySafe: true,
      code: "NOT_CONNECTED",
      message: "node not connected",
      nodeCommandDispatched: false,
      requestSent: true,
    });
  });

  it.each([
    {
      name: "deadline before dispatch",
      error: gatewayNodeInvokeError({
        code: "TIMEOUT",
        nodeCommandDispatched: false,
      }),
    },
    {
      name: "disconnect after dispatch",
      error: gatewayNodeInvokeError({
        code: "DISCONNECTED",
        nodeCommandDispatched: true,
      }),
    },
    {
      name: "missing dispatch provenance",
      error: gatewayNodeInvokeError({ code: "NOT_CONNECTED" }),
    },
    {
      name: "client timeout before request bytes crossed send",
      error: Object.assign(new Error("gateway request timeout for node.invoke"), {
        name: "GatewayClientRequestTimeoutError",
        requestSent: false,
      }),
    },
    {
      name: "malformed failure",
      error: { message: 42 },
    },
  ])("classifies $name as outcome-unknown", async ({ error }) => {
    await expect(invokeFailure(error)).resolves.toMatchObject({
      reason: "outcome-unknown",
      retrySafe: false,
    });
  });

  it("preserves multiline command metadata in an outcome-unknown followup", async () => {
    const failure = await invokeFailure(
      gatewayNodeInvokeError({
        code: "TIMEOUT",
        message: "node invoke timed out",
        nodeCommandDispatched: true,
      }),
    );
    const text = formatNodeInvokeFailureFollowup({
      failure,
      nodeId: "node-1",
      approvalId: "approval-1",
      command: "printf 'one\\ntwo'\necho done",
    });

    expect(text).toContain("Exec outcome unknown (node=node-1 id=approval-1, outcome-unknown)");
    expect(text).toContain("The command may have executed. Do not rerun it automatically.");
    expect(text).toContain("Command:\nprintf 'one\\ntwo'\necho done");
  });
});

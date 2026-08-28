import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatNodeInvokeFailureFollowup,
  invokeNodeSystemRun,
} from "./bash-tools.exec-host-node-failure.js";
import { invokeNodeSystemRunDirect } from "./bash-tools.exec-host-node-phases.js";

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

    expect(text).toContain("Command:\nprintf 'one\\ntwo'\necho done");
  });
});

type DirectNodeRun = Parameters<typeof invokeNodeSystemRunDirect>[0];

function createDirectNodeRun(signal?: AbortSignal): DirectNodeRun {
  return {
    request: {
      command: "tool --version",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      ...(signal ? { signal } : {}),
    },
    target: {
      nodeId: "node-1",
      argv: ["tool", "--version"],
      env: undefined,
      invokeDeadlineMs: 30_000,
      invokeWaitMs: 35_000,
      runTimeoutSec: 30,
      supportsSystemRunPrepare: true,
    },
  };
}

describe("direct node run", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockResolvedValue({
      payload: { success: true, stdout: "ok", stderr: "", exitCode: 0 },
    });
  });

  it("forwards the original cancellation signal to the gateway", async () => {
    const controller = new AbortController();
    await invokeNodeSystemRunDirect(createDirectNodeRun(controller.signal));

    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 35_000 },
      expect.objectContaining({ command: "system.run" }),
      { signal: controller.signal },
    );
  });

  it("combines stdout, stderr, and the node error", async () => {
    const stdout = "small stdout";
    const stderr = "node stderr";
    const errorText = "node command failed";
    callGatewayToolMock.mockResolvedValueOnce({
      payload: {
        success: false,
        stdout,
        stderr,
        error: errorText,
        exitCode: 1,
      },
    });

    const result = await invokeNodeSystemRunDirect(createDirectNodeRun());
    const visibleText = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(visibleText).toBe(`${stdout}\n${stderr}\n${errorText}\n(Command exited with code 1)`);
    expect(result.details).toMatchObject({ aggregated: visibleText });
  });

  it("renders a nonzero exit code in the model-visible text", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      payload: { success: false, stdout: "done", stderr: "", error: null, exitCode: 3 },
    });

    const result = await invokeNodeSystemRunDirect(createDirectNodeRun());
    const visibleText = result.content[0]?.type === "text" ? result.content[0].text : "";

    // Output alone must not read as success when the command failed.
    expect(visibleText).toContain("done");
    expect(visibleText).toContain("(Command exited with code 3)");
    expect(result.details).toMatchObject({ status: "failed", exitCode: 3 });
  });

  it("renders a timeout marker and records timedOut in details", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      payload: { success: false, stdout: "", stderr: "", error: null, timedOut: true },
    });

    const result = await invokeNodeSystemRunDirect(createDirectNodeRun());
    const visibleText = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(visibleText).toContain("Command timed out.");
    expect(result.details).toMatchObject({ status: "failed", timedOut: true });
  });

  it("never dispatches a direct node run after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before direct node dispatch");
    controller.abort(reason);

    await expect(invokeNodeSystemRunDirect(createDirectNodeRun(controller.signal))).rejects.toBe(
      reason,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });
});

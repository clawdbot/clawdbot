import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  formatNodeInvokeFailureFollowup,
  invokeNodeSystemRun,
} from "./bash-tools.exec-host-node-failure.js";
import {
  dispatchNodeSystemRun,
  resolveNodeExecutionTarget,
} from "./bash-tools.exec-host-node-phases.js";

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

describe("node execution target resolution", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
  });

  it("rejects legacy paired-node records without execution capabilities", async () => {
    callGatewayToolMock
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "unknown method: node.list",
        }),
      )
      .mockResolvedValueOnce({ paired: [{ nodeId: "legacy-node", platform: "linux" }] });

    await expect(resolveNodeExecutionTarget(createDirectNodeRun().request)).rejects.toThrow(
      /supports system.run/,
    );
    expect(callGatewayToolMock.mock.calls.map(([method]) => method)).toEqual([
      "node.list",
      "node.pair.list",
    ]);
  });

  it("requires an explicit target when multiple connected nodes support system.run", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      nodes: [
        {
          nodeId: "mac-a",
          displayName: "Desk Mac",
          platform: "macos",
          caps: ["canvas"],
          commands: ["system.run"],
          connected: true,
          connectedAtMs: 1_000,
          active: true,
        },
        {
          nodeId: "mac-b",
          displayName: "Travel Mac",
          platform: "macos",
          caps: ["canvas"],
          commands: ["system.run"],
          connected: true,
          connectedAtMs: 2_000,
        },
      ],
    });

    await expect(resolveNodeExecutionTarget(createDirectNodeRun().request)).rejects.toThrow(
      /multiple.*mac-a.*mac-b/i,
    );
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
    expect(callGatewayToolMock).toHaveBeenCalledWith("node.list", {}, {}, { signal: undefined });
  });

  it.each([
    { name: "alone", siblings: [] },
    {
      name: "beside a connected non-executor",
      siblings: [
        {
          nodeId: "canvas-only",
          caps: ["canvas"],
          commands: ["canvas.present"],
          connected: true,
        },
      ],
    },
    {
      name: "beside an offline non-executor",
      siblings: [
        {
          nodeId: "canvas-only",
          caps: ["canvas"],
          commands: ["canvas.present"],
          connected: false,
        },
      ],
    },
  ])("selects the sole headless executor $name", async ({ siblings }) => {
    callGatewayToolMock.mockResolvedValueOnce({
      nodes: [
        ...siblings,
        {
          nodeId: "exec-node",
          platform: "linux",
          caps: ["system"],
          commands: ["system.run"],
          connected: true,
        },
      ],
    });

    await expect(resolveNodeExecutionTarget(createDirectNodeRun().request)).resolves.toMatchObject({
      nodeId: "exec-node",
    });
  });

  it("honors an explicit executable node among multiple candidates", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      nodes: [
        { nodeId: "node-a", commands: ["system.run"], connected: true },
        { nodeId: "node-b", commands: ["system.run"], connected: true },
      ],
    });

    await expect(
      resolveNodeExecutionTarget({ ...createDirectNodeRun().request, requestedNode: "node-a" }),
    ).resolves.toMatchObject({ nodeId: "node-a" });
  });

  it.each(["build-worker", "node-shared-"])(
    "rejects an ambiguous configured binding %s before filtering executable nodes",
    async (boundNode) => {
      callGatewayToolMock.mockResolvedValueOnce({
        nodes: [
          {
            nodeId: "node-shared-exec",
            displayName: "build-worker",
            commands: ["system.run"],
            connected: true,
          },
          {
            nodeId: "node-shared-canvas",
            displayName: "build-worker",
            commands: ["canvas.present"],
            connected: true,
          },
        ],
      });

      await expect(
        resolveNodeExecutionTarget({ ...createDirectNodeRun().request, boundNode }),
      ).rejects.toThrow(/ambiguous node/);
      expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
    },
  );
});

type DirectNodeRun = Parameters<typeof dispatchNodeSystemRun>[0];

function createDirectNodeRun(signal?: AbortSignal): DirectNodeRun {
  return {
    invoke: {
      nodeId: "node-1",
      command: "system.run",
      params: { command: ["tool", "--version"], rawCommand: "tool --version" },
    },
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

  it.each(["timeout", "malformed response"])("keeps %s outcomes ambiguous", async (kind) => {
    if (kind === "timeout") {
      callGatewayToolMock.mockRejectedValueOnce(
        gatewayNodeInvokeError({
          code: "TIMEOUT",
          nodeCommandDispatched: true,
        }),
      );
    } else {
      callGatewayToolMock.mockResolvedValueOnce({ payload: { stdout: "partial" } });
    }
    const result = await dispatchNodeSystemRun(createDirectNodeRun());
    expect(result.details).toMatchObject({ status: "failed", reason: "outcome-unknown" });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(
          "The command may have executed. Do not rerun it automatically.",
        ),
      }),
    ]);
  });

  it("forwards the original cancellation signal to the gateway", async () => {
    const controller = new AbortController();
    await dispatchNodeSystemRun(createDirectNodeRun(controller.signal));

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

    const result = await dispatchNodeSystemRun(createDirectNodeRun());
    const visibleText = result.content[0]?.type === "text" ? result.content[0].text : "";

    const output = `${stdout}\n${stderr}\n${errorText}\n(Command exited with code 1)`;
    expect(visibleText).toBe(`Node: node-1\n${output}`);
    expect(result.details).toMatchObject({ aggregated: output, nodeId: "node-1" });
  });

  it("identifies the node in the successful result the model reads", async () => {
    const result = await dispatchNodeSystemRun(createDirectNodeRun());

    expect(result.content).toEqual([{ type: "text", text: "Node: node-1\nok" }]);
    expect(result.details).toMatchObject({
      status: "completed",
      aggregated: "ok",
      nodeId: "node-1",
    });
  });

  it("renders a nonzero exit code in the model-visible text", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      payload: { success: false, stdout: "done", stderr: "", error: null, exitCode: 3 },
    });

    const result = await dispatchNodeSystemRun(createDirectNodeRun());
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

    const result = await dispatchNodeSystemRun(createDirectNodeRun());
    const visibleText = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(visibleText).toContain("Command timed out.");
    expect(visibleText).toContain("Node: node-1");
    expect(result.details).toMatchObject({ status: "failed", timedOut: true });
  });

  it("never dispatches a direct node run after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before direct node dispatch");
    controller.abort(reason);

    await expect(dispatchNodeSystemRun(createDirectNodeRun(controller.signal))).rejects.toBe(
      reason,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });
});

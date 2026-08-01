import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayTool = vi.hoisted(() =>
  vi.fn(async () => ({
    payload: { success: true, stdout: "ok", stderr: "", exitCode: 0 },
  })),
);

vi.mock("./tools/gateway.js", () => ({ callGatewayTool }));

import { invokeNodeSystemRunDirect } from "./bash-tools.exec-host-node-phases.js";

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
      invokeTimeoutMs: 30_000,
      runTimeoutSec: 30,
      supportsSystemRunPrepare: true,
    },
  };
}

describe("direct node run cancellation", () => {
  beforeEach(() => {
    callGatewayTool.mockClear();
  });

  it("forwards the original cancellation signal to the gateway", async () => {
    const controller = new AbortController();

    await invokeNodeSystemRunDirect(createDirectNodeRun(controller.signal));

    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 30_000 },
      expect.objectContaining({ command: "system.run" }),
      { signal: controller.signal },
    );
  });

  it("preserves the original gateway call when no signal is supplied", async () => {
    await invokeNodeSystemRunDirect(createDirectNodeRun());

    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 30_000 },
      expect.objectContaining({ command: "system.run" }),
    );
  });

  it("never dispatches a direct node run after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before direct node dispatch");
    controller.abort(reason);

    await expect(invokeNodeSystemRunDirect(createDirectNodeRun(controller.signal))).rejects.toBe(
      reason,
    );
    expect(callGatewayTool).not.toHaveBeenCalled();
  });
});

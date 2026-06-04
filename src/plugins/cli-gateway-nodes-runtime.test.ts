/** Tests plugin CLI node Gateway runtime timeout and invocation behavior. */
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginCliGatewayNodesRuntime,
  resolvePluginCliNodeInvokeGatewayTimeoutMs,
} from "./cli-gateway-nodes-runtime.js";

const callGatewayMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

describe("createPluginCliGatewayNodesRuntime", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({});
  });

  it("caps oversized node invoke gateway timeouts", async () => {
    const nodes = createPluginCliGatewayNodesRuntime();

    await nodes.invoke({
      nodeId: "node-1",
      command: "system.run",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        timeoutMs: MAX_TIMER_TIMEOUT_MS,
        params: expect.objectContaining({
          timeoutMs: Number.MAX_SAFE_INTEGER,
        }),
      }),
    );
  });
});

describe("resolvePluginCliNodeInvokeGatewayTimeoutMs", () => {
  it("preserves absent and non-positive timeout behavior", () => {
    expect(resolvePluginCliNodeInvokeGatewayTimeoutMs(undefined)).toBeUndefined();
    expect(resolvePluginCliNodeInvokeGatewayTimeoutMs(0)).toBeUndefined();
    expect(resolvePluginCliNodeInvokeGatewayTimeoutMs(-1)).toBeUndefined();
  });

  it("adds gateway grace for normal positive timeouts", () => {
    expect(resolvePluginCliNodeInvokeGatewayTimeoutMs(10_000)).toBe(15_000);
  });
});

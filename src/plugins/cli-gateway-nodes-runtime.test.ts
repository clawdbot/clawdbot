/** Tests plugin CLI node Gateway runtime timeout and invocation behavior. */
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginCliGatewayNodesRuntime } from "./cli-gateway-nodes-runtime.js";
import { withPluginRuntimePluginScope } from "./runtime/gateway-request-scope.js";

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

  it("forwards requested node invoke scopes for bundled plugin CLI runtime", async () => {
    const nodes = createPluginCliGatewayNodesRuntime();

    await withPluginRuntimePluginScope({ pluginId: "google-meet", pluginOrigin: "bundled" }, () =>
      nodes.invoke({
        nodeId: "node-1",
        command: "browser.proxy",
        scopes: ["operator.admin"],
      }),
    );

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        scopes: ["operator.admin"],
      }),
    );
  });

  it("drops requested node invoke scopes for third-party plugin CLI runtime", async () => {
    const nodes = createPluginCliGatewayNodesRuntime();

    await withPluginRuntimePluginScope({ pluginId: "third-party", pluginOrigin: "global" }, () =>
      nodes.invoke({
        nodeId: "node-1",
        command: "browser.proxy",
        scopes: ["operator.admin"],
      }),
    );

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        scopes: expect.anything(),
      }),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureGlobalUndiciEnvProxyDispatcherMock = vi.fn();

vi.mock("../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: ensureGlobalUndiciEnvProxyDispatcherMock,
}));

const { bootstrapGatewayNetworkRuntime } = await import("./server-network-runtime.js");

describe("bootstrapGatewayNetworkRuntime", () => {
  beforeEach(() => {
    ensureGlobalUndiciEnvProxyDispatcherMock.mockClear();
  });

  it("installs the env proxy dispatcher for gateway-owned network work", () => {
    bootstrapGatewayNetworkRuntime();

    expect(ensureGlobalUndiciEnvProxyDispatcherMock).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const lazyState = vi.hoisted(() => ({
  loads: 0,
  startCalls: [] as unknown[][],
  resetCalls: 0,
}));

vi.mock("./server.impl.js", () => {
  lazyState.loads += 1;
  return {
    startGatewayServer: vi.fn(async (...args: unknown[]) => {
      lazyState.startCalls.push(args);
      return { close: vi.fn(async () => undefined) };
    }),
    resetModelCatalogCacheForTest: vi.fn(() => {
      lazyState.resetCalls += 1;
    }),
  };
});

describe("gateway server boundary", () => {
  beforeEach(() => {
    lazyState.loads = 0;
    lazyState.startCalls = [];
    lazyState.resetCalls = 0;
  });

  it("lazy-loads server.impl on demand", async () => {
    const mod = await import("./server.js");

    expect(lazyState.loads).toBe(0);

    await mod.resetModelCatalogCacheForTest();
    expect(lazyState.loads).toBe(1);
    expect(lazyState.resetCalls).toBe(1);

    await mod.startGatewayServer(4321, { bind: "loopback" });
    expect(lazyState.loads).toBe(1);
    expect(lazyState.startCalls).toEqual([[4321, { bind: "loopback" }]]);
  });
});

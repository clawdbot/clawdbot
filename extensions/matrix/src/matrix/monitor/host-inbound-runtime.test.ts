import { describe, expect, it, vi } from "vitest";
import { resolveMatrixHostInboundRuntime } from "./host-inbound-runtime.js";

describe("Matrix host inbound runtime", () => {
  it("uses the gateway-supplied owner-scoped inbound runtime", () => {
    const fallback = { buildContext: vi.fn(), run: vi.fn() } as never;
    const hostBuildContext = vi.fn();
    const hostRun = vi.fn();
    const hostInbound = { buildContext: hostBuildContext, run: hostRun };

    expect(
      resolveMatrixHostInboundRuntime({
        channelRuntime: {
          inbound: hostInbound,
          runtimeContexts: {} as never,
        },
        fallback,
      }),
    ).toBe(hostInbound);
  });

  it("preserves the existing fallback outside a gateway account lifetime", () => {
    const fallback = { buildContext: vi.fn(), run: vi.fn() } as never;

    expect(
      resolveMatrixHostInboundRuntime({
        channelRuntime: { runtimeContexts: {} as never },
        fallback,
      }),
    ).toBe(fallback);
  });

  it("falls back atomically instead of mixing a partial host runtime", () => {
    const fallback = { buildContext: vi.fn(), run: vi.fn() } as never;

    for (const inbound of [{ buildContext: vi.fn() }, { run: vi.fn() }]) {
      expect(
        resolveMatrixHostInboundRuntime({
          channelRuntime: { inbound, runtimeContexts: {} as never },
          fallback,
        }),
      ).toBe(fallback);
    }
  });
});

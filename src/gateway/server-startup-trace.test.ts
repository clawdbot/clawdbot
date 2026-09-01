import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayStartupTrace } from "./server-startup-trace.js";

describe("gateway startup trace", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps pre-bootstrap and startup phases on one elapsed-time origin", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
    const info = vi.fn();
    const trace = createGatewayStartupTrace(
      { info } as unknown as Parameters<typeof createGatewayStartupTrace>[0],
      performance.now() - 10,
    );

    trace.mark("process.bootstrap");
    await trace.measure("state.ownership", async () => {});

    const messages = info.mock.calls.map(([message]) => String(message));
    const preBootstrap = messages.find((message) => message.includes("process.bootstrap"));
    const ownership = messages.find((message) => message.includes("state.ownership"));
    expect(preBootstrap).toContain("total=");
    expect(ownership).toContain("total=");
    expect(messages.indexOf(preBootstrap ?? "")).toBeLessThan(messages.indexOf(ownership ?? ""));
  });
});

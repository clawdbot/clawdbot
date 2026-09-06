import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const eventLoopDelay = vi.hoisted(() => ({
  instances: [] as Array<{
    disable: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
    percentile: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("node:perf_hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:perf_hooks")>();
  return {
    ...actual,
    monitorEventLoopDelay: vi.fn(() => {
      const instance = {
        disable: vi.fn(),
        enable: vi.fn(),
        percentile: vi.fn(() => 0),
        reset: vi.fn(),
      };
      eventLoopDelay.instances.push(instance);
      return { ...instance, max: 0 };
    }),
  };
});

import { createGatewayStartupTrace } from "./server-startup-trace.js";

describe("gateway startup trace", () => {
  beforeEach(() => {
    eventLoopDelay.instances.length = 0;
    vi.clearAllMocks();
  });

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

  it("closes the event-loop monitor once without allowing it to reopen", () => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
    const trace = createGatewayStartupTrace({ info: vi.fn() } as never);

    trace.close();
    trace.close();
    trace.setConfig({});
    trace.mark("ready");

    expect(eventLoopDelay.instances).toHaveLength(1);
    expect(eventLoopDelay.instances[0]?.enable).toHaveBeenCalledOnce();
    expect(eventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
  });

  it("keeps tracing after a measured error until startup reaches a terminal outcome", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
    const trace = createGatewayStartupTrace({ info: vi.fn() } as never);

    await expect(
      trace.measure("sidecars.channel-start", async () => {
        throw new Error("channel unavailable");
      }),
    ).rejects.toThrow("channel unavailable");

    expect(eventLoopDelay.instances[0]?.disable).not.toHaveBeenCalled();
    trace.mark("sidecars.ready");
    expect(eventLoopDelay.instances[0]?.reset).toHaveBeenCalled();
    expect(eventLoopDelay.instances[0]?.disable).not.toHaveBeenCalled();

    trace.mark("ready");
    expect(eventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
  });
});

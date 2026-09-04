import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { finishGatewayRestartTrace, startGatewayRestartTrace } from "./restart-trace.js";
import { runGatewayShutdownSteps } from "./server-shutdown.js";

const logInfo = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: logInfo }),
}));

afterEach(() => {
  finishGatewayRestartTrace("test.finish");
  vi.unstubAllEnvs();
  logInfo.mockClear();
});

describe("gateway shutdown steps", () => {
  it.each([false, true])(
    "reports a held step before it settles without changing order (trace=%s)",
    async (trace) => {
      vi.stubEnv("OPENCLAW_GATEWAY_RESTART_TRACE", trace ? "1" : "0");
      startGatewayRestartTrace("stop.signal.received");
      const entered = createDeferredCore();
      const released = createDeferredCore();
      const second = vi.fn();
      const onError = vi.fn();
      const closing = runGatewayShutdownSteps({
        steps: [
          {
            name: "gateway lifetime sidecars",
            run: async () => {
              entered.resolve();
              await released.promise;
            },
          },
          { name: "second", run: second },
        ],
        onError,
      });
      const messages = () => logInfo.mock.calls.map(([message]) => String(message));
      try {
        await entered.promise;
        expect(second).not.toHaveBeenCalled();
        expect(
          messages().some((line) => line.includes("shutdown.gateway-lifetime-sidecars.begin ")),
        ).toBe(trace);
        expect(
          messages().some((line) => line.includes("shutdown.gateway-lifetime-sidecars ")),
        ).toBe(false);
        expect(messages().some((line) => line.includes("shutdown.second"))).toBe(false);
      } finally {
        released.resolve();
        await closing;
      }
      expect(second).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(messages().some((line) => line.includes("shutdown.gateway-lifetime-sidecars "))).toBe(
        trace,
      );
      expect(messages().some((line) => line.includes("shutdown.second "))).toBe(trace);
    },
  );

  it("names an unavailable module step and continues the remaining shutdown", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_RESTART_TRACE", "1");
    startGatewayRestartTrace("stop.signal.received");
    const missingModule = Object.assign(new Error("Cannot find module 'rotated-chunk.js'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const loadStopModule = vi.fn(async () => {
      throw missingModule;
    });
    const closeGateway = vi.fn(async () => {});
    const messages: string[] = [];

    await runGatewayShutdownSteps({
      steps: [
        { name: "gateway lifetime sidecars", run: loadStopModule },
        { name: "gateway close", run: closeGateway },
      ],
      onError: (message) => messages.push(message),
    });

    expect(closeGateway).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      "shutdown step failed (gateway lifetime sidecars): Cannot find module 'rotated-chunk.js'",
    ]);
    expect(messages.join("\n")).not.toContain("shutdown error");
    const trace = logInfo.mock.calls.map(([message]) => String(message));
    const failedStep = trace.findIndex((line) =>
      line.includes("shutdown.gateway-lifetime-sidecars "),
    );
    const nextStep = trace.findIndex((line) => line.includes("shutdown.gateway-close.begin "));
    expect(failedStep).toBeGreaterThanOrEqual(0);
    expect(nextStep).toBeGreaterThan(failedStep);
  });
});

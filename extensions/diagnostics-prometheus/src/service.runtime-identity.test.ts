import { describe, expect, it, vi } from "vitest";
import { baseEvent, createMetricsHarness, trusted } from "./service.test-helpers.js";

describe("diagnostics-prometheus runtime identity", () => {
  it("does not read or publish runtime identity when diagnostics are disabled at startup", () => {
    const readIdentity = vi.fn(() => ({
      processInstanceId: "a6aa1fc7-1f10-4b56-8ae8-4ff8c4dc02ea",
    }));
    const metrics = createMetricsHarness(readIdentity, { diagnostics: { enabled: false } });
    expect(readIdentity).not.toHaveBeenCalled();
    expect(metrics.render()).toBe("");
    metrics.stop();
  });

  it.each([undefined, "2026.9.1-fixture-build"])(
    "captures runtime identity once with build ID %s and keeps it through saturation",
    (buildId) => {
      const identity = {
        processInstanceId: "a6aa1fc7-1f10-4b56-8ae8-4ff8c4dc02ea",
        ...(buildId ? { buildId } : {}),
      };
      const readIdentity = vi.fn(() => identity);
      const metrics = createMetricsHarness(readIdentity);
      const info = `openclaw_gateway_build_info{${buildId ? `build_id="${buildId}",` : ""}process_instance_id="${identity.processInstanceId}"} 1`;
      const initial = metrics.render();
      expect(initial).toContain("# TYPE openclaw_gateway_build_info gauge");
      expect(initial).toContain(info);
      identity.processInstanceId = "a-different-value-after-service-start";
      expect(metrics.render()).toBe(initial);
      expect(readIdentity).toHaveBeenCalledOnce();
      for (let index = 0; index < 2100; index += 1) {
        metrics.record(
          { ...baseEvent(), type: "gateway.rpc", method: `method.${index}`, phase: "received" },
          trusted,
        );
      }
      expect(metrics.render()).toContain(info);
      expect(metrics.render()).toContain("openclaw_prometheus_series_dropped_total 53");
      metrics.stop();
      expect(metrics.render()).toBe("");
      identity.processInstanceId = "a6aa1fc7-1f10-4b56-8ae8-4ff8c4dc02ea";
      metrics.start();
      expect(metrics.render()).toContain(info);
      expect(metrics.render()).not.toContain("openclaw_prometheus_series_dropped_total");
      expect(readIdentity).toHaveBeenCalledTimes(2);
      metrics.stop();
    },
  );

  it("leaves runtime identity absent on hosts without the optional capability", () => {
    const metrics = createMetricsHarness();
    expect(metrics.render()).toBe("");
    metrics.record(
      { ...baseEvent(), type: "gateway.rpc", method: "health", phase: "received" },
      trusted,
    );
    expect(metrics.render()).toContain('openclaw_gateway_rpc_requests_total{method="health"} 1');
    expect(metrics.render()).not.toContain("openclaw_gateway_build_info");
    metrics.stop();
  });
});

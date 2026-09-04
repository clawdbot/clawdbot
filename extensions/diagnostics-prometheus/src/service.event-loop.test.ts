import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { baseEvent, createMetricsHarness, trusted, untrusted } from "./service.test-helpers.js";

describe("diagnostics-prometheus event-loop metrics", () => {
  it.each([false, true])(
    "caps series growth while retaining admitted event-loop windows (preseed=%s)",
    (preseed) => {
      const metrics = createMetricsHarness();
      const sample = {
        ...baseEvent(),
        type: "gateway.event_loop.sample",
        intervalMs: 1_000,
        delayMaxMs: 20,
      } as const;
      try {
        if (preseed) {
          metrics.record(sample, trusted);
        }
        for (let index = 0; index < 2100; index += 1) {
          metrics.record(
            {
              ...baseEvent(),
              type: "model.call.completed",
              runId: `run-${index}`,
              callId: `call-${index}`,
              provider: "openai",
              model: `model.${index}`,
              durationMs: 10,
            },
            trusted,
          );
        }
        const drops = () =>
          Number(
            metrics
              .render()
              .split("\n")
              .find((line) => line.startsWith("openclaw_prometheus_series_dropped_total "))
              ?.split(" ")
              .at(-1),
          );
        const before = drops();
        expect(before).toBeGreaterThan(0);
        metrics.record(sample, trusted);
        expect(drops()).toBe(before + (preseed ? 0 : 2));
        const rendered = metrics.render();
        if (preseed) {
          expect(rendered).toContain("openclaw_gateway_event_loop_delay_max_seconds_count 2");
          expect(rendered).toContain("openclaw_gateway_event_loop_observed_seconds_total 2");
        } else {
          expect(rendered).not.toContain("openclaw_gateway_event_loop_");
        }
      } finally {
        metrics.stop();
      }
    },
  );

  it("retains event-loop windows across repeated HTTP scrapes without labels", async () => {
    const metrics = createMetricsHarness();
    const server = createServer((req, res) => {
      void metrics.handler(req, res);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const scrape = async () => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/diagnostics/prometheus`);
        expect(response.status).toBe(200);
        return await response.text();
      };
      metrics.record(
        { ...baseEvent(), type: "gateway.event_loop.sample", intervalMs: 2_000, delayMaxMs: 1_250 },
        trusted,
      );
      const first = await scrape();
      expect(first).toContain("openclaw_gateway_event_loop_delay_max_seconds_count 1");
      expect(first).toContain("openclaw_gateway_event_loop_observed_seconds_total 2");
      expect(await scrape()).toBe(first);
      metrics.record(
        { ...baseEvent(), type: "gateway.event_loop.sample", intervalMs: 8_000, delayMaxMs: 20 },
        Object.freeze({ trusted: false, internal: true }),
      );
      metrics.record(
        {
          ...baseEvent(),
          type: "gateway.event_loop.sample",
          intervalMs: 99_000,
          delayMaxMs: 99_000,
        },
        untrusted,
      );
      const second = await scrape();
      for (const expected of [
        'openclaw_gateway_event_loop_delay_max_seconds_bucket{le="1"} 1',
        'openclaw_gateway_event_loop_delay_max_seconds_bucket{le="2.5"} 2',
        "openclaw_gateway_event_loop_delay_max_seconds_count 2",
        "openclaw_gateway_event_loop_delay_max_seconds_sum 1.27",
        "openclaw_gateway_event_loop_observed_seconds_total 10",
      ]) {
        expect(second).toContain(expected);
      }
      expect(await scrape()).toBe(second);
      expect(second).not.toMatch(/\{(?!le=)/);
    } finally {
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeIdleConnections();
          });
        }
      } finally {
        metrics.stop();
      }
    }
  });
});

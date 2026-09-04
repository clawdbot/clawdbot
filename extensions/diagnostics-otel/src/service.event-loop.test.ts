import { context, metrics, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  emitDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { emitInternalDiagnosticEventForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import {
  startOtelService,
  startOtlpReceiver,
  stopStartedOtelServices,
} from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();

test.each([
  { mode: "metrics-only", metricsEnabled: true, traces: false, logs: false },
  { mode: "all signals", metricsEnabled: true, traces: true, logs: true },
  { mode: "traces-only", metricsEnabled: false, traces: true, logs: false },
  { mode: "logs-only", metricsEnabled: false, traces: false, logs: true },
])(
  "retains event-loop windows only as metrics with a preloaded SDK ($mode)",
  async ({ metricsEnabled, traces, logs }) => {
    const receiver = await startOtlpReceiver();
    let meterProvider: MeterProvider | undefined;
    try {
      context.disable();
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const observedParents: Array<string | undefined> = [];
      meterProvider = new MeterProvider({
        readers: [
          new PeriodicExportingMetricReader({
            exporter: metricExporter,
            exportIntervalMillis: 60_000,
          }),
        ],
        views: [
          {
            instrumentName: "openclaw.gateway.event_loop.*",
            attributesProcessors: [
              {
                process(attributes, measurementContext) {
                  observedParents.push(
                    measurementContext
                      ? trace.getSpanContext(measurementContext)?.traceId
                      : undefined,
                  );
                  return attributes;
                },
              },
            ],
          },
        ],
      });
      metrics.disable();
      expect(metrics.setGlobalMeterProvider(meterProvider)).toBe(true);
      let deliveredSamples = 0;
      await startOtelService({
        endpoint: receiver.endpoint,
        traces,
        metrics: metricsEnabled,
        logs,
        configure(serviceContext) {
          const bridge = serviceContext.internalDiagnostics!;
          serviceContext.internalDiagnostics = {
            ...bridge,
            onEvent(listener, filter) {
              return bridge.onEvent((event, metadata, privateData) => {
                if (event.type === "gateway.event_loop.sample") {
                  deliveredSamples++;
                }
                listener(event, metadata, privateData);
              }, filter);
            },
          };
        },
      });
      await waitForDiagnosticEventsDrained();
      const ambientTraceId = "11111111111111111111111111111111";
      const ambient = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: ambientTraceId,
        spanId: "1111111111111111",
        traceFlags: 1,
      });
      const sampleMetrics = () =>
        Object.fromEntries(
          (
            metricExporter
              .getMetrics()
              .at(-1)
              ?.scopeMetrics.flatMap((scope) => scope.metrics) ?? []
          )
            .filter((metric) => metric.descriptor.name.startsWith("openclaw.gateway.event_loop."))
            .map(
              (metric) =>
                [
                  metric.descriptor.name,
                  {
                    unit: metric.descriptor.unit,
                    points: metric.dataPoints.map(({ attributes, value }) => ({
                      attributes,
                      value,
                    })),
                  },
                ] as const,
            ),
        );
      for (const [intervalMs, delayMaxMs, totalMs, count, sum] of [
        [2_000, 1_250, 2_000, 1, 1_250],
        [8_000, 20, 10_000, 2, 1_270],
      ] as const) {
        await context.with(ambient, async () => {
          expect(trace.getSpanContext(context.active())?.traceId).toBe(ambientTraceId);
          emitInternalDiagnosticEventForTest({
            type: "gateway.event_loop.sample",
            intervalMs,
            delayMaxMs,
          });
          await waitForDiagnosticEventsDrained();
        });
        await meterProvider.forceFlush();
        if (metricsEnabled) {
          expect(sampleMetrics()).toMatchObject({
            "openclaw.gateway.event_loop.delay_max_ms": {
              unit: "ms",
              points: [{ attributes: {}, value: { count, sum } }],
            },
            "openclaw.gateway.event_loop.observed_ms": {
              unit: "ms",
              points: [{ attributes: {}, value: totalMs }],
            },
          });
        } else {
          expect(sampleMetrics()).toEqual({});
        }
      }
      const retained = sampleMetrics();
      emitDiagnosticEvent({
        type: "gateway.event_loop.sample",
        intervalMs: 99_000,
        delayMaxMs: 99_000,
      });
      await waitForDiagnosticEventsDrained();
      await meterProvider.forceFlush();
      expect(sampleMetrics()).toEqual(retained);
      expect(
        Object.values(sampleMetrics()).flatMap((metric) =>
          metric.points.map(({ attributes }) => attributes),
        ),
      ).toEqual(metricsEnabled ? [{}, {}] : []);
      expect(deliveredSamples).toBe(metricsEnabled ? 3 : 0);
      expect(observedParents).toEqual(
        metricsEnabled ? [undefined, undefined, undefined, undefined] : [],
      );
      await stopStartedOtelServices();
      expect(sdk.exporter.getFinishedSpans()).toEqual([]);
      expect(receiver.requests).toEqual([]);
    } finally {
      try {
        await stopStartedOtelServices();
      } finally {
        try {
          await meterProvider?.shutdown();
        } finally {
          await receiver.close();
        }
      }
    }
  },
  30_000,
);

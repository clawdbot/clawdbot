import { describe, expect, it, vi } from "vitest";
import type { DiagnosticEventMetadata, DiagnosticEventPayload } from "../api.js";
import { createDiagnosticsPrometheusExporter, __test__ } from "./service.js";

const trusted: DiagnosticEventMetadata = Object.freeze({ trusted: true });
const untrusted: DiagnosticEventMetadata = Object.freeze({ trusted: false });

function baseEvent(): Pick<DiagnosticEventPayload, "seq" | "ts"> {
  return { seq: 1, ts: 1700000000000 };
}

describe("diagnostics-prometheus service", () => {
  it("records trusted run metrics without raw diagnostic identifiers", () => {
    const store = __test__.createPrometheusMetricStore();

    __test__.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "run.completed",
        runId: "run-should-not-export",
        sessionKey: "session-should-not-export",
        provider: "openai",
        model: "gpt-5.4",
        channel: "discord",
        trigger: "message",
        durationMs: 1500,
        outcome: "completed",
      },
      trusted,
    );

    const rendered = __test__.renderPrometheusMetrics(store);

    expect(rendered).toContain("# TYPE openclaw_run_completed_total counter");
    expect(rendered).toContain(
      'openclaw_run_completed_total{channel="discord",model="gpt-5.4",outcome="completed",provider="openai",trigger="message"} 1',
    );
    expect(rendered).toContain(
      'openclaw_run_duration_seconds_sum{channel="discord",model="gpt-5.4",outcome="completed",provider="openai",trigger="message"} 1.5',
    );
    expect(rendered).not.toContain("run-should-not-export");
    expect(rendered).not.toContain("session-should-not-export");
  });

  it("drops untrusted plugin-emitted diagnostic events", () => {
    const store = __test__.createPrometheusMetricStore();

    __test__.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "model.call.completed",
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 10,
      },
      untrusted,
    );

    expect(__test__.renderPrometheusMetrics(store)).toBe("");
  });

  it("redacts and bounds label values", () => {
    const store = __test__.createPrometheusMetricStore();

    __test__.recordDiagnosticEvent(
      store,
      {
        ...baseEvent(),
        type: "tool.execution.error",
        toolName: "shell\nbad",
        durationMs: 25,
        errorCategory: "Bearer sk-secret-token-value",
      },
      trusted,
    );

    const rendered = __test__.renderPrometheusMetrics(store);

    expect(rendered).toContain(
      'openclaw_tool_execution_total{error_category="other",outcome="error",params_kind="unknown",tool="tool"} 1',
    );
    expect(rendered).not.toContain("Bearer");
    expect(rendered).not.toContain("sk-secret");
  });

  it("caps metric series growth and reports dropped series", () => {
    const store = __test__.createPrometheusMetricStore();

    for (let index = 0; index < 2100; index += 1) {
      __test__.recordDiagnosticEvent(
        store,
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

    const rendered = __test__.renderPrometheusMetrics(store);

    expect(rendered).toContain("# TYPE openclaw_prometheus_series_dropped_total counter");
    expect(rendered).toContain("openclaw_prometheus_series_dropped_total ");
  });

  it("subscribes to internal diagnostics and renders scrape text", () => {
    const listeners: Array<
      (event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => void
    > = [];
    const emitted: unknown[] = [];
    const exporter = createDiagnosticsPrometheusExporter();
    const unsubscribe = vi.fn();

    exporter.service.start({
      config: {} as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      internalDiagnostics: {
        emit: (event) => emitted.push(event),
        onEvent: (listener) => {
          listeners.push(listener);
          return unsubscribe;
        },
      },
    });

    listeners[0]?.(
      {
        ...baseEvent(),
        type: "model.usage",
        provider: "openai",
        model: "gpt-5.4",
        usage: { input: 12, output: 3, total: 15 },
      },
      trusted,
    );

    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "telemetry.exporter",
        exporter: "diagnostics-prometheus",
        signal: "metrics",
        status: "started",
      }),
    );
    expect(exporter.render()).toContain(
      'openclaw_model_tokens_total{agent="unknown",channel="unknown",model="gpt-5.4",provider="openai",token_type="input"} 12',
    );

    exporter.service.stop?.();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(exporter.render()).toBe("");
  });
});

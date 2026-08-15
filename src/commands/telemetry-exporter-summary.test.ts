import { describe, expect, it } from "vitest";
import { formatTelemetryExporterSummary } from "./telemetry-exporter-summary.js";

describe("formatTelemetryExporterSummary", () => {
  it("renders bounded redacted exporter facts without misattribution", () => {
    const summary = formatTelemetryExporterSummary({
      events: [
        {
          seq: 1,
          type: "telemetry.exporter",
          source: "https://spoofed.example",
          target: "traces",
          transport: "otlp-http-protobuf",
          outcome: "failure",
          reason: "export_failed",
        },
        {
          seq: 2,
          type: "telemetry.exporter",
          source: "diagnostics-otel",
          target: "traces",
          transport: "otlp-http-protobuf",
          outcome: "recovered",
          reason: "export_failed",
          mode: "default_endpoint",
          url: "https://collector.example/private",
          headers: { authorization: "secret" },
          error: "raw collector failure",
        },
        {
          seq: 3,
          type: "telemetry.exporter",
          source: "diagnostics-prometheus",
          target: "metrics",
          transport: "prometheus-scrape",
          outcome: "failure",
          reason: "handler_failed",
        },
        {
          seq: 4,
          type: "telemetry.exporter",
          source: "custom_exporter",
          target: "metrics",
          transport: "external-sdk",
          outcome: "started",
          reason: "configured",
        },
        {
          seq: 5,
          type: "telemetry.exporter",
          source: "diagnostics-otel",
          target: "logs",
          transport: "stdout",
          outcome: "started",
          reason: "configured",
        },
      ],
    });

    expect(summary).toEqual({
      title: "Telemetry exporters",
      status: "warn",
      lines: [
        "custom_exporter · metrics · started · external SDK ownership",
        "diagnostics-otel · traces · recovered · OTLP/HTTP protobuf (dependency default endpoint) · after export failure",
        "diagnostics-otel · logs · started · stdout",
        "diagnostics-prometheus · metrics · failed · prometheus-scrape · handler failed",
      ],
    });
    expect(JSON.stringify(summary)).not.toContain("collector.example");
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("raw collector failure");
    expect(JSON.stringify(summary)).not.toContain("spoofed.example");
  });

  it("warns for a final exporter failure", () => {
    expect(
      formatTelemetryExporterSummary({
        events: [
          {
            seq: 1,
            type: "telemetry.exporter",
            source: "diagnostics-otel",
            target: "logs",
            transport: "otlp-http-protobuf",
            outcome: "failure",
            reason: "shutdown_failed",
            mode: "configured",
          },
        ],
      }),
    ).toEqual({
      title: "Telemetry exporters",
      status: "warn",
      lines: [
        "diagnostics-otel · logs · failed · OTLP/HTTP protobuf (explicit endpoint) · shutdown failed",
      ],
    });
  });

  it("renders startup failures with explicit and dependency-default ownership", () => {
    expect(
      formatTelemetryExporterSummary({
        events: [
          {
            seq: 1,
            type: "telemetry.exporter",
            source: "diagnostics-otel",
            target: "traces",
            transport: "otlp-http-protobuf",
            outcome: "failure",
            reason: "start_failed",
            mode: "default_endpoint",
          },
          {
            seq: 2,
            type: "telemetry.exporter",
            source: "diagnostics-otel",
            target: "metrics",
            transport: "otlp-http-protobuf",
            outcome: "failure",
            reason: "start_failed",
            mode: "configured",
          },
        ],
      }),
    ).toEqual({
      title: "Telemetry exporters",
      status: "warn",
      lines: [
        "diagnostics-otel · traces · failed · OTLP/HTTP protobuf (dependency default endpoint) · start failed",
        "diagnostics-otel · metrics · failed · OTLP/HTTP protobuf (explicit endpoint) · start failed",
      ],
    });
  });

  it("renders stdout recovery without exposing failure details", () => {
    expect(
      formatTelemetryExporterSummary({
        events: [
          {
            seq: 1,
            type: "telemetry.exporter",
            source: "diagnostics-otel",
            target: "logs",
            transport: "stdout",
            outcome: "recovered",
            reason: "emit_failed",
            error: "private stdout details",
          },
        ],
      }),
    ).toEqual({
      title: "Telemetry exporters",
      status: "ok",
      lines: ["diagnostics-otel · logs · recovered · stdout · after emit failure"],
    });
  });

  it("renders safe unknown transports and redacts unsafe ones", () => {
    const summary = formatTelemetryExporterSummary({
      events: [
        {
          seq: 1,
          type: "telemetry.exporter",
          source: "custom_exporter",
          target: "logs",
          transport: "vendor-proto",
          outcome: "started",
          reason: "configured",
        },
        {
          seq: 2,
          type: "telemetry.exporter",
          source: "second_exporter",
          target: "metrics",
          transport: "collector.internal:4318",
          outcome: "failure",
          reason: "queue_full",
        },
      ],
    });

    expect(summary).toEqual({
      title: "Telemetry exporters",
      status: "warn",
      lines: [
        "custom_exporter · logs · started · vendor-proto",
        "second_exporter · metrics · failed · exporter · queue full",
      ],
    });
    expect(JSON.stringify(summary)).not.toContain("collector.internal");
  });
});

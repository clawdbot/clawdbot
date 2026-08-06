import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticEventPayload } from "../api.js";
import { observeOtlpExporterHealth } from "./service-exporter-health.js";

type ExporterEvent = Extract<DiagnosticEventPayload, { type: "telemetry.exporter" }>;

function createObservedExporter(events: ExporterEvent[]) {
  let resultCallback: ((result: ExportResult) => void) | undefined;
  const shutdown = vi.fn(async () => {});
  const exporter = {
    export: vi.fn((_items: unknown, callback: (result: ExportResult) => void) => {
      resultCallback = callback;
    }),
    shutdown,
  };
  observeOtlpExporterHealth(exporter, {
    signal: "traces",
    emitExporterEvent: (event) => {
      events.push({ type: "telemetry.exporter", seq: 1, ts: 1, ...event });
    },
  });
  return {
    exporter,
    shutdown,
    complete(result: ExportResult) {
      if (!resultCallback) {
        throw new Error("export callback was not registered");
      }
      resultCallback(result);
    },
  };
}

describe("observeOtlpExporterHealth", () => {
  it("emits one final failure transition and one recovery transition", () => {
    const events: ExporterEvent[] = [];
    const observed = createObservedExporter(events);
    const consumerCallback = vi.fn();

    observed.exporter.export([], consumerCallback);
    observed.complete({
      code: ExportResultCode.FAILED,
      error: new Error("collector unavailable"),
    });
    observed.exporter.export([], consumerCallback);
    observed.complete({
      code: ExportResultCode.FAILED,
      error: new Error("collector still unavailable"),
    });
    observed.exporter.export([], consumerCallback);
    observed.complete({ code: ExportResultCode.SUCCESS });

    expect(events).toEqual([
      expect.objectContaining({
        signal: "traces",
        transport: "otlp-http-protobuf",
        status: "failure",
        reason: "export_failed",
        errorCategory: "Error",
      }),
      expect.objectContaining({
        signal: "traces",
        transport: "otlp-http-protobuf",
        status: "recovered",
        reason: "export_failed",
      }),
    ]);
    expect(consumerCallback).toHaveBeenCalledTimes(3);
  });

  it("records a shutdown rejection without exposing its message", async () => {
    const events: ExporterEvent[] = [];
    const observed = createObservedExporter(events);
    observed.shutdown.mockRejectedValueOnce(new TypeError("private collector details"));

    await expect(observed.exporter.shutdown()).rejects.toThrow("private collector details");
    expect(events).toEqual([
      expect.objectContaining({
        signal: "traces",
        transport: "otlp-http-protobuf",
        status: "failure",
        reason: "shutdown_failed",
        errorCategory: "TypeError",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private collector details");
  });

  it("records and rethrows a synchronous dependency export failure once", () => {
    const events: ExporterEvent[] = [];
    const exportItems = vi.fn(() => {
      throw new TypeError("private serialization details");
    });
    const exporter = {
      export: exportItems,
      shutdown: vi.fn(async () => {}),
    };
    observeOtlpExporterHealth(exporter, {
      signal: "logs",
      emitExporterEvent: (event) => {
        events.push({ type: "telemetry.exporter", seq: 1, ts: 1, ...event });
      },
    });

    expect(() => exporter.export([], vi.fn())).toThrow("private serialization details");
    expect(() => exporter.export([], vi.fn())).toThrow("private serialization details");
    expect(events).toEqual([
      expect.objectContaining({
        signal: "logs",
        transport: "otlp-http-protobuf",
        status: "failure",
        reason: "export_failed",
        errorCategory: "TypeError",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private serialization details");
  });

  it("does not misclassify a synchronous consumer callback failure", () => {
    const events: ExporterEvent[] = [];
    const exporter = {
      export: vi.fn((_items: unknown, callback: (result: ExportResult) => void) => {
        callback({ code: ExportResultCode.SUCCESS });
      }),
      shutdown: vi.fn(async () => {}),
    };
    observeOtlpExporterHealth(exporter, {
      signal: "metrics",
      emitExporterEvent: (event) => {
        events.push({ type: "telemetry.exporter", seq: 1, ts: 1, ...event });
      },
    });

    expect(() =>
      exporter.export([], () => {
        throw new Error("consumer callback failed");
      }),
    ).toThrow("consumer callback failed");
    expect(events).toEqual([]);
  });
});

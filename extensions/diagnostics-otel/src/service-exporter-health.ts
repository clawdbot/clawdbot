import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { errorCategory } from "./service-exporter.js";
import type { TelemetryExporterDiagnosticEvent } from "./service-types.js";

type ObservableOtlpExporter = {
  export(items: unknown, resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
};

type ExporterEvent = Omit<TelemetryExporterDiagnosticEvent, "type" | "seq" | "ts">;
type FailureReason = NonNullable<ExporterEvent["reason"]> | "unspecified";

/** Owns route transitions so one producer cannot recover another producer's failure. */
export function createExporterHealthEventEmitter(publish: (event: ExporterEvent) => void) {
  const failures = new Map<
    string,
    { active: Map<FailureReason, ExporterEvent>; reported?: FailureReason }
  >();
  return (event: ExporterEvent) => {
    const key = `${event.exporter}\u0000${event.signal}\u0000${event.transport ?? "unknown"}`;
    if (event.status === "started" || event.status === "dropped") {
      failures.delete(key);
      publish(event);
      return;
    }
    const reason = event.reason ?? "unspecified";
    if (event.status === "failure") {
      const route = failures.get(key) ?? { active: new Map<FailureReason, ExporterEvent>() };
      failures.set(key, route);
      if (route.active.has(reason)) {
        return;
      }
      route.active.set(reason, event);
      if (route.reported === undefined) {
        route.reported = reason;
        publish(event);
      }
      return;
    }
    const route = failures.get(key);
    if (!route?.active.delete(reason) || route.reported !== reason) {
      return;
    }
    const next = route.active.entries().next().value;
    if (next) {
      route.reported = next[0];
      publish(next[1]);
      return;
    }
    failures.delete(key);
    publish(event);
  };
}

/**
 * Observes the exporter result callback, which runs only after the OTLP
 * transport has exhausted dependency-owned retries.
 */
export function observeOtlpExporterHealth<TExporter extends object>(
  exporter: TExporter,
  params: {
    emitExporterEvent: (event: ExporterEvent) => void;
    signal: TelemetryExporterDiagnosticEvent["signal"];
  },
): TExporter {
  const observed = exporter as unknown as ObservableOtlpExporter;
  const exportItems = observed.export.bind(observed);
  const shutdown = observed.shutdown.bind(observed);

  const emit = (
    status: TelemetryExporterDiagnosticEvent["status"],
    reason: "export_failed" | "shutdown_failed",
    error?: unknown,
  ) => {
    params.emitExporterEvent({
      exporter: "diagnostics-otel",
      signal: params.signal,
      transport: "otlp-http-protobuf",
      status,
      reason,
      ...(error ? { errorCategory: errorCategory(error) } : {}),
    });
  };

  observed.export = (items, resultCallback) => {
    let dependencyCallbackInvoked = false;
    try {
      exportItems(items, (result) => {
        dependencyCallbackInvoked = true;
        if (result.code === ExportResultCode.FAILED) {
          emit("failure", "export_failed", result.error);
        } else if (result.code === ExportResultCode.SUCCESS) {
          emit("recovered", "export_failed");
        }
        resultCallback(result);
      });
    } catch (error) {
      // The delegate serializes before creating its transport promise, so that
      // path can throw without invoking the result callback.
      if (!dependencyCallbackInvoked) {
        emit("failure", "export_failed", error);
      }
      throw error;
    }
  };

  observed.shutdown = async () => {
    try {
      await shutdown();
    } catch (error) {
      emit("failure", "shutdown_failed", error);
      throw error;
    }
  };

  return exporter;
}

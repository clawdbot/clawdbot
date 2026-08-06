import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { errorCategory } from "./service-exporter.js";
import type { TelemetryExporterDiagnosticEvent } from "./service-types.js";

type ObservableOtlpExporter = {
  export(items: unknown, resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
};

/**
 * Observes the exporter result callback, which runs only after the OTLP
 * transport has exhausted dependency-owned retries.
 */
export function observeOtlpExporterHealth<TExporter extends object>(
  exporter: TExporter,
  params: {
    emitExporterEvent: (
      event: Omit<TelemetryExporterDiagnosticEvent, "type" | "seq" | "ts">,
    ) => void;
    signal: TelemetryExporterDiagnosticEvent["signal"];
  },
): TExporter {
  const observed = exporter as unknown as ObservableOtlpExporter;
  const exportItems = observed.export.bind(observed);
  const shutdown = observed.shutdown.bind(observed);
  let exportFailed = false;

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
  const noteExportFailure = (error: unknown) => {
    if (exportFailed) {
      return;
    }
    exportFailed = true;
    emit("failure", "export_failed", error);
  };

  observed.export = (items, resultCallback) => {
    let dependencyCallbackInvoked = false;
    try {
      exportItems(items, (result) => {
        dependencyCallbackInvoked = true;
        if (result.code === ExportResultCode.FAILED) {
          noteExportFailure(result.error);
        } else if (result.code === ExportResultCode.SUCCESS && exportFailed) {
          exportFailed = false;
          emit("recovered", "export_failed");
        }
        resultCallback(result);
      });
    } catch (error) {
      // The delegate serializes before creating its transport promise, so that
      // path can throw without invoking the result callback.
      if (!dependencyCallbackInvoked) {
        noteExportFailure(error);
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

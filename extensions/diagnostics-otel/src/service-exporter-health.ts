import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { errorCategory } from "./service-exporter.js";

type ObservableOtlpExporter = {
  export(items: unknown, resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
};

type ExporterHealthReason =
  | "configured"
  | "default_endpoint"
  | "emit_failed"
  | "export_failed"
  | "handler_failed"
  | "queue_full"
  | "shutdown_failed"
  | "start_failed"
  | "unsupported_protocol";

export type ExporterHealthUpdate = {
  exporter: string;
  signal: "traces" | "metrics" | "logs";
  transport: "otlp-http-protobuf" | "stdout" | "external-sdk";
  endpointMode?: "configured" | "default_endpoint";
  status: "started" | "failure" | "recovered" | "dropped";
  reason?: ExporterHealthReason;
  errorCategory?: string;
};

type FailureReason = ExporterHealthReason | "unspecified";
type PublicExporterHealthUpdate = Omit<ExporterHealthUpdate, "status"> & {
  status: Exclude<ExporterHealthUpdate["status"], "recovered">;
};
type PublicSignalState = {
  routes: Set<ExporterHealthUpdate["transport"]>;
  started: boolean;
  routeFailures: Map<ExporterHealthUpdate["transport"], string>;
};

function publicFailureKey(event: ExporterHealthUpdate): string {
  return `${event.reason ?? "unspecified"}\u0000${event.errorCategory ?? "unknown"}`;
}

/** Owns route transitions so one producer cannot recover another producer's failure. */
export function createExporterHealthEventEmitter(publish: (event: ExporterHealthUpdate) => void) {
  const failures = new Map<
    string,
    { active: Map<FailureReason, ExporterHealthUpdate>; reported?: FailureReason }
  >();
  return (event: ExporterHealthUpdate) => {
    const key = `${event.exporter}\u0000${event.signal}\u0000${event.transport}`;
    if (event.status === "started" || event.status === "dropped") {
      failures.delete(key);
      publish(event);
      return;
    }
    const reason = event.reason ?? "unspecified";
    if (event.status === "failure") {
      const route = failures.get(key) ?? {
        active: new Map<FailureReason, ExporterHealthUpdate>(),
      };
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

/** Coalesces private transport transitions into the shipped signal-level public stream. */
export function createPublicExporterHealthEventEmitter(
  publish: (event: PublicExporterHealthUpdate) => void,
) {
  const signals = new Map<string, PublicSignalState>();
  return (event: ExporterHealthUpdate) => {
    const signalKey = `${event.exporter}\u0000${event.signal}`;
    let state = signals.get(signalKey);
    if (!state) {
      if (event.status === "dropped") {
        return;
      }
      state = {
        routes: new Set(),
        started: false,
        routeFailures: new Map(),
      };
      signals.set(signalKey, state);
    }

    const routeKey = event.transport;
    if (event.status === "dropped") {
      const removed = state.routes.delete(routeKey);
      state.routeFailures.delete(routeKey);
      if (!removed || state.routes.size > 0) {
        return;
      }
      signals.delete(signalKey);
      publish({ ...event, status: "dropped" });
      return;
    }

    state.routes.add(routeKey);
    if (event.status === "started") {
      state.routeFailures.delete(routeKey);
      if (state.started) {
        return;
      }
      state.started = true;
      publish({ ...event, status: "started" });
      return;
    }
    if (event.status === "recovered") {
      state.routeFailures.delete(routeKey);
      return;
    }

    const failureKey = publicFailureKey(event);
    if (state.routeFailures.get(routeKey) === failureKey) {
      return;
    }
    const duplicate = [...state.routeFailures.entries()].some(
      ([transport, activeFailure]) => transport !== routeKey && activeFailure === failureKey,
    );
    state.routeFailures.set(routeKey, failureKey);
    if (!duplicate) {
      publish({ ...event, status: "failure" });
    }
  };
}

/**
 * Observes the exporter result callback, which runs only after the OTLP
 * transport has exhausted dependency-owned retries.
 */
export function observeOtlpExporterHealth<TExporter extends object>(
  exporter: TExporter,
  params: {
    emitExporterEvent: (event: ExporterHealthUpdate) => void;
    signal: ExporterHealthUpdate["signal"];
  },
): TExporter {
  const observed = exporter as unknown as ObservableOtlpExporter;
  const exportItems = observed.export.bind(observed);
  const shutdown = observed.shutdown.bind(observed);

  const emit = (
    status: ExporterHealthUpdate["status"],
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

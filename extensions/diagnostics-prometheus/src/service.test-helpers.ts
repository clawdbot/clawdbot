import { expectDefined } from "@openclaw/normalization-core";
import type { DiagnosticEventPrivateData } from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  OpenClawPluginServiceContext,
} from "../api.js";
import { createDiagnosticsPrometheusExporter } from "./service.js";

export const trusted: DiagnosticEventMetadata = Object.freeze({ trusted: true });
export const untrusted: DiagnosticEventMetadata = Object.freeze({ trusted: false });
export type ExporterHealthReport = {
  signal: "metrics";
  transport: "prometheus-scrape";
  status: "started" | "dropped";
  reason?: "configured";
};
export type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth?: (update: ExporterHealthReport) => void;
};

export function baseEvent(): Pick<DiagnosticEventPayload, "seq" | "ts"> {
  return { seq: 1, ts: 1700000000000 };
}

export function createMetricsHarness(
  getRuntimeIdentity?: NonNullable<
    OpenClawPluginServiceContext["internalDiagnostics"]
  >["getRuntimeIdentity"],
  config: OpenClawPluginServiceContext["config"] = {},
) {
  const exporter = createDiagnosticsPrometheusExporter();
  let listener:
    | ((
        event: DiagnosticEventPayload,
        metadata: DiagnosticEventMetadata,
        privateData: DiagnosticEventPrivateData,
      ) => void)
    | undefined;
  const internalDiagnostics: TrustedExporterInternalDiagnostics = {
    ...(getRuntimeIdentity ? { getRuntimeIdentity } : {}),
    emit() {},
    onEvent(nextListener) {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    },
    reportExporterHealth() {},
  };
  const context: OpenClawPluginServiceContext = {
    config,
    stateDir: "/tmp/openclaw-prometheus-test",
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    internalDiagnostics,
  };
  const start = () => exporter.service.start(context);
  start();
  return {
    handler: exporter.handler,
    record(event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) {
      expectDefined(listener, "Prometheus diagnostics listener")(event, metadata, {});
    },
    render: exporter.render,
    start,
    stop: () => exporter.service.stop?.(),
  };
}

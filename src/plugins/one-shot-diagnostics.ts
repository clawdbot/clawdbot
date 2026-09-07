/** Starts diagnostics exporter plugin services for one-shot CLI embedded agent runs. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("plugins");

// Only push-based exporters that can flush before a short-lived process exits.
// diagnostics-prometheus is pull-based (scrape server) and would bind a port
// that races the gateway on the same host, so it stays gateway-only.
const ONE_SHOT_DIAGNOSTICS_SERVICE_IDS = new Set(["diagnostics-otel"]);
// Separate drain and flush waits preserve buffered telemetry after a stalled drain.
// These limits do not cancel exporter-owned work or replace its network request timeout.
const ONE_SHOT_DIAGNOSTICS_DRAIN_TIMEOUT_MS = 5_000;
const ONE_SHOT_DIAGNOSTICS_FLUSH_TIMEOUT_MS = 10_000;

export type OneShotDiagnosticsHandle = {
  stop: () => Promise<void>;
};

function suppressOtelStdoutLogSink(config: OpenClawConfig): OpenClawConfig {
  const diagnostics = config.diagnostics;
  const otel = diagnostics?.otel;
  if (otel?.logs !== true || (otel.logsExporter !== "stdout" && otel.logsExporter !== "both")) {
    return config;
  }
  // JSON-mode agent CLI stdout is machine-readable output. The OTel stdout
  // log sink writes directly to process.stdout, so suppress only that sink for
  // one-shot exporters while preserving OTLP diagnostics where configured.
  return {
    ...config,
    diagnostics: {
      ...diagnostics,
      otel: {
        ...otel,
        logs: otel.logsExporter === "both",
        logsExporter: "otlp",
      },
    },
  };
}

function isOtelExportConfigured(config: OpenClawConfig): boolean {
  // Mirrors the diagnostics-otel service's own start() gate so disabled
  // configs skip plugin loading entirely on the CLI hot path.
  const diagnostics = config.diagnostics;
  return Boolean(diagnostics && diagnostics.enabled !== false && diagnostics.otel?.enabled);
}

/**
 * Start the diagnostics OTel exporter for a one-shot embedded agent run.
 *
 * Gateway processes start diagnostics exporters via startPluginServices at
 * startup; one-shot `openclaw agent --local` runs execute the agent in the CLI
 * process where no plugin service ever starts, so diagnostic events had no OTel
 * subscriber and spans were dropped.
 * Returns null when OTel export is not configured or the plugin is not
 * enabled/installed; the returned handle's stop() drains the diagnostic event
 * queue and shuts the SDK down (force-flush) before the process exits.
 */
export async function startOneShotDiagnosticsExporters(params: {
  config: OpenClawConfig;
  suppressStdoutDiagnosticLogs?: boolean;
}): Promise<OneShotDiagnosticsHandle | null> {
  const config =
    params.suppressStdoutDiagnosticLogs === true
      ? suppressOtelStdoutLogSink(params.config)
      : params.config;
  if (!isOtelExportConfigured(config)) {
    return null;
  }
  const [{ loadOpenClawPlugins }, { startPluginServices }] = await Promise.all([
    import("./loader.js"),
    import("./services.js"),
  ]);
  // Scoped, non-activating load: honors the same plugin enablement config as
  // the gateway's startup load without replacing the active runtime registry
  // the embedded run resolves providers/tools from.
  const registry = loadOpenClawPlugins({
    config,
    onlyPluginIds: [...ONE_SHOT_DIAGNOSTICS_SERVICE_IDS],
    activate: false,
    preferBuiltPluginArtifacts: true,
  });
  // The scope-piggyback loader rules (e.g. dreaming sidecars) can widen a
  // scoped load, so re-filter to the flush-safe exporter allowlist.
  const services = registry.services.filter((entry) =>
    ONE_SHOT_DIAGNOSTICS_SERVICE_IDS.has(entry.service.id),
  );
  if (services.length === 0) {
    // diagnostics-otel is an external plugin, so "enabled in config, never
    // installed" is an ordinary state. Say so: the run would otherwise export
    // nothing with nothing explaining why.
    log.warn(
      "diagnostics.otel is enabled but the diagnostics-otel plugin is not installed or not enabled; this run exports no telemetry.",
    );
    return null;
  }
  const handle = await startPluginServices({
    registry: { ...registry, services },
    config,
    oneShotStopTimeouts: {
      eventDrainMs: ONE_SHOT_DIAGNOSTICS_DRAIN_TIMEOUT_MS,
      serviceStopMs: ONE_SHOT_DIAGNOSTICS_FLUSH_TIMEOUT_MS,
    },
  });
  return {
    stop: async () => {
      try {
        await handle.stop();
      } catch (error) {
        for (const failure of error instanceof AggregateError ? error.errors : [error]) {
          log.warn(`one-shot diagnostics shutdown failed: ${String(failure)}`);
        }
      }
    },
  };
}

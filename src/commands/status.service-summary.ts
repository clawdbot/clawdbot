// Reads service manager state for status reports.
// Converts gateway/node launchd/systemd state into a compact summary shape.

import { OPENCLAW_WRAPPER_ENV_KEY } from "../daemon/program-args.js";
import {
  summarizeGatewayServiceLayout,
  type GatewayServiceLayoutSummary,
} from "../daemon/service-layout.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceLoadState,
} from "../daemon/service-types.js";
import { readGatewayServiceState, type GatewayService } from "../daemon/service.js";

type ServiceStatusSummary = {
  label: string;
  installed: boolean | null;
  loadState: GatewayServiceLoadState;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: GatewayServiceRuntime | undefined;
  layout?: GatewayServiceLayoutSummary;
  wrapperPath?: string;
};

function normalizeServiceWrapperPath(
  command: GatewayServiceCommandConfig | null,
): string | undefined {
  const wrapperPath = command?.environment?.[OPENCLAW_WRAPPER_ENV_KEY]?.trim();
  return wrapperPath || undefined;
}

/** Reads a daemon service summary, falling back to unknown when service inspection fails. */
export async function readServiceStatusSummary(
  service: GatewayService,
  fallbackLabel: string,
  timeoutMs?: number,
): Promise<ServiceStatusSummary> {
  try {
    const state = await readGatewayServiceState(service, { env: process.env, timeoutMs });
    // Layout is optional enrichment; a broken manifest or inaccessible path
    // must not erase service-manager evidence that the gateway is running.
    const layout = await summarizeGatewayServiceLayout(state.command).catch(() => undefined);
    const wrapperPath = normalizeServiceWrapperPath(state.command);
    const managedByOpenClaw = state.installed;
    // A running unmanaged process still counts as installed for status display.
    const externallyManaged = !managedByOpenClaw && state.running;
    const installed = managedByOpenClaw || externallyManaged;
    const loadedText = externallyManaged
      ? "running (externally managed)"
      : state.loadState.status === "loaded"
        ? service.loadedText
        : state.loadState.status === "not-loaded"
          ? service.notLoadedText
          : "unknown";
    return {
      label: service.label,
      installed,
      loadState: state.loadState,
      managedByOpenClaw,
      externallyManaged,
      loadedText,
      runtime: state.runtime,
      ...(layout ? { layout } : {}),
      ...(wrapperPath ? { wrapperPath } : {}),
    };
  } catch (error) {
    // Status output should survive service-manager errors and show an unknown row.
    return {
      label: fallbackLabel,
      installed: null,
      loadState: { status: "unknown", detail: String(error) },
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "unknown",
      runtime: undefined,
    };
  }
}

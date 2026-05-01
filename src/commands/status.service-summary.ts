import {
  summarizeGatewayServiceLayout,
  type GatewayServiceLayoutSummary,
} from "../daemon/service-layout.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { readGatewayServiceState, type GatewayService } from "../daemon/service.js";

export type ServiceStatusSummary = {
  label: string;
  installed: boolean | null;
  loaded: boolean;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: GatewayServiceRuntime | undefined;
  layout?: GatewayServiceLayoutSummary;
};

export async function readServiceStatusSummary(
  service: GatewayService,
  fallbackLabel: string,
): Promise<ServiceStatusSummary> {
  try {
    const state = await readGatewayServiceState(service, { env: process.env });
    const layout = await summarizeGatewayServiceLayout(state.command);
    const managedByOpenClaw = state.installed;
    const externallyManaged = !managedByOpenClaw && state.running;
    const installed = managedByOpenClaw || externallyManaged;
    const loadedText = externallyManaged
      ? "running (externally managed)"
      : state.loaded
        ? service.loadedText
        : service.notLoadedText;
    return {
      label: service.label,
      installed,
      loaded: state.loaded,
      managedByOpenClaw,
      externallyManaged,
      loadedText,
      runtime: state.runtime,
      ...(layout ? { layout } : {}),
    };
  } catch {
    return {
      label: fallbackLabel,
      installed: null,
      loaded: false,
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "unknown",
      runtime: undefined,
    };
  }
}

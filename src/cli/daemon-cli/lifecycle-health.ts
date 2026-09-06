import { theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  type GatewayPortHealthSnapshot,
  renderGatewayPortHealthDiagnostics,
} from "./restart-health.js";

export function hasGatewayPluginReadinessFailure(
  health: Pick<GatewayPortHealthSnapshot, "activatedPluginErrors" | "unavailablePlugins">,
): boolean {
  return Boolean(health.activatedPluginErrors?.length || health.unavailablePlugins?.length);
}

export function failGatewayPluginReadiness(params: {
  action: "start" | "restart";
  health: GatewayPortHealthSnapshot;
  json: boolean;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
}): never {
  const pluginIds = [
    ...(params.health.activatedPluginErrors ?? []).map((plugin) => plugin.id),
    ...(params.health.unavailablePlugins ?? []).map((plugin) => plugin.id),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
  const message = `Gateway ${params.action} completed, but configured plugin health failed for ${pluginIds.join(", ")}. The Gateway remains running in degraded mode.`;
  const diagnostics = renderGatewayPortHealthDiagnostics(params.health);
  if (params.json) {
    params.warnings.push(...diagnostics);
  } else {
    defaultRuntime.log(theme.warn(message));
    for (const line of diagnostics) {
      defaultRuntime.log(theme.muted(line));
    }
  }
  params.fail(message, [
    formatCliCommand("openclaw plugins doctor"),
    formatCliCommand("openclaw gateway status --deep"),
  ]);
  throw new Error("unreachable after gateway plugin readiness failure");
}

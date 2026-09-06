import type { PluginInstallRequest } from "../../lib/plugins/index.ts";
import type { PluginInstallPolicyWarningDetails } from "./install-policy-warning.ts";

export type PluginRowMessage = {
  kind: "success" | "error" | "warning";
  text: string;
  installPolicyWarning?: {
    details: PluginInstallPolicyWarningDetails;
    request: PluginInstallRequest;
  };
};

export function pluginRowKey(pluginId: string): string {
  return `plugin:${pluginId}`;
}

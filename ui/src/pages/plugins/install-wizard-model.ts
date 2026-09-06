import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginInstallRequest,
} from "../../lib/plugins/index.ts";

export type PluginInstallWizardStage =
  | "review"
  | "installing"
  | "policy-warning"
  | "reconnecting"
  | "configuring"
  | "enabling"
  | "success"
  | "error";

export type PluginInstallWizardState = {
  catalogId: string;
  detail: PluginDiscoveryDetailResult;
  request: PluginInstallRequest;
  stage: PluginInstallWizardStage;
  pluginId?: string;
  error?: string;
  policyReason?: string;
};

export function installRequestForDiscoveryDetail(
  result: PluginDiscoveryDetailResult,
): PluginInstallRequest | null {
  if (result.plugin.local.installed || result.plugin.local.action !== "install") {
    return null;
  }
  if (result.plugin.local.install) {
    return result.plugin.local.install;
  }
  const packageName = result.detail.packageName?.trim();
  return packageName ? { source: "clawhub", packageName } : null;
}

export function installedPluginWizardStage(
  plugin: PluginCatalogItem,
): Extract<PluginInstallWizardStage, "configuring" | "enabling" | "success"> {
  if (plugin.enabled && plugin.state === "enabled") {
    return "success";
  }
  return plugin.state === "needs-setup" ? "configuring" : "enabling";
}

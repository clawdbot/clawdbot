import type { PluginPackageInstall } from "./package-manifest.js";

export function normalizePluginInstallDefaultChoice(
  value: unknown,
): PluginPackageInstall["defaultChoice"] | undefined {
  return value === "clawhub" || value === "npm" || value === "local" ? value : undefined;
}

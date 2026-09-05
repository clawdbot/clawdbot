import type { PluginPackageInstall } from "./manifest.js";

export function normalizePluginInstallDefaultChoice(
  value: unknown,
): PluginPackageInstall["defaultChoice"] | undefined {
  return value === "clawhub" || value === "npm" || value === "local" ? value : undefined;
}

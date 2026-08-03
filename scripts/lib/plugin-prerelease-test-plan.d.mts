export type PluginPrereleaseStaticCheck = {
  check: string;
  checkName: string;
  command: string;
  surfaces: string[];
};

export type PluginPrereleaseTestPlan = {
  dockerLanes: string[];
  staticChecks: PluginPrereleaseStaticCheck[];
  surfaces: string[];
};

export const PLUGIN_PRERELEASE_REQUIRED_SURFACES: readonly string[];
export function createPluginPrereleaseTestPlan(): PluginPrereleaseTestPlan;
export function assertPluginPrereleaseTestPlanComplete(
  plan?: PluginPrereleaseTestPlan,
): PluginPrereleaseTestPlan;

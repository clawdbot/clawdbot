import type { GatewayReloadPlan } from "./config-reload-plan.js";

export function shouldRefreshContextWindowCache(plan: GatewayReloadPlan): boolean {
  return (
    plan.reloadPlugins ||
    plan.changedPaths.some(
      (path) =>
        path === "models" ||
        path.startsWith("models.") ||
        path === "agents" ||
        path === "agents.defaults" ||
        path === "agents.list" ||
        path.startsWith("agents.list.") ||
        path === "agents.defaults.workspace" ||
        path.startsWith("agents.defaults.workspace."),
    )
  );
}

export function reloadPlanNeedsRecovery(plan: GatewayReloadPlan): boolean {
  return (
    plan.restartCron ||
    plan.restartHealthMonitor ||
    plan.restartGmailWatcher ||
    plan.reloadPlugins ||
    plan.restartChannels.size > 0 ||
    shouldRefreshContextWindowCache(plan)
  );
}

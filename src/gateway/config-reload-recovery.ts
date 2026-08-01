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
        path === "agents.entries" ||
        path.startsWith("agents.entries.") ||
        path === "agents.defaults.workspace" ||
        path.startsWith("agents.defaults.workspace."),
    )
  );
}

/** Provider-auth rewarm only helps reloads that change agent scope, model
 *  catalogs, provider config, or auth inputs; unrelated reloads skip the
 *  O(agents×providers) scan and fall through to compute. */
export function shouldRewarmProviderAuthState(plan: GatewayReloadPlan): boolean {
  return plan.reloadPlugins || plan.changedPaths.some(isProviderAuthRelevantReloadPath);
}

// Auth answers depend on the agent workspace/agentDir (auth store location),
// model/provider routing, plugin runtime, and secret refs. Keep this list
// conservative: a miss only delays the scan, never serves a stale answer,
// because the whole-config fingerprint guard falls through to compute.
const PROVIDER_AUTH_RELEVANT_AGENT_SUBFIELDS = new Set([
  "model",
  "models",
  "modelPolicy",
  "utilityModel",
  "agentRuntime",
  "workspace",
  "agentDir",
]);

// Subagent model selection routes to a provider, so a whole-object add/remove
// and the model leaf are auth-relevant at both the defaults and per-agent
// levels; other subagent fields (thinking, limits) are not.
function isAuthRelevantAgentSubfield(field: string | undefined, next: string | undefined): boolean {
  if (field === undefined) {
    return true;
  }
  if (PROVIDER_AUTH_RELEVANT_AGENT_SUBFIELDS.has(field)) {
    return true;
  }
  return field === "subagents" && (next === undefined || next === "model");
}

function isProviderAuthRelevantReloadPath(path: string): boolean {
  const segments = path.split(".");
  const [head, second, third, fourth] = segments;
  if (head === "models" || head === "secrets") {
    return true;
  }
  if (head === "agent" && second === "model") {
    return true;
  }
  if (head !== "agents") {
    return false;
  }
  if (second === undefined) {
    return true;
  }
  if (second === "defaults") {
    return isAuthRelevantAgentSubfield(third, segments[3]);
  }
  if (second === "entries") {
    return isAuthRelevantAgentSubfield(fourth, segments[4]);
  }
  return false;
}

export function reloadPlanNeedsRecovery(plan: GatewayReloadPlan): boolean {
  return (
    plan.restartCron ||
    plan.restartHealthMonitor ||
    plan.restartGmailWatcher ||
    plan.reloadPlugins ||
    plan.restartChannels.size > 0 ||
    (plan.restartChannelAccounts?.size ?? 0) > 0 ||
    shouldRefreshContextWindowCache(plan)
  );
}

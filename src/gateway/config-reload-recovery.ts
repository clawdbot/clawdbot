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

/** Auth changes must replace prepared owners instead of advancing their config in place. */
export function doesReloadAffectProviderAuth(plan: GatewayReloadPlan): boolean {
  return plan.reloadPlugins || plan.changedPaths.some(isProviderAuthRelevantReloadPath);
}

const PROVIDER_AUTH_RELEVANT_CONFIG_ROOTS = new Set([
  "auth",
  "env",
  "models",
  "plugins",
  "secrets",
]);
const PROVIDER_AUTH_RELEVANT_AGENT_SUBFIELDS = new Set([
  "agentDir",
  "agentRuntime",
  "default",
  "id",
  "imageModel",
  "mediaModels",
  "model",
  "models",
  "modelPolicy",
  "pdfModel",
  "runtime",
  "utilityModel",
  "voiceModel",
  "workspace",
]);

// Nested model selectors can change providers; unrelated scheduling/compaction knobs cannot.
function isAuthRelevantAgentSubfield(
  field: string | undefined,
  next: string | undefined,
  nested: string | undefined,
): boolean {
  if (field === undefined) {
    return true;
  }
  if (PROVIDER_AUTH_RELEVANT_AGENT_SUBFIELDS.has(field)) {
    return true;
  }
  if (field === "heartbeat" || field === "subagents") {
    return next === undefined || next === "model";
  }
  return (
    field === "compaction" &&
    (next === undefined ||
      next === "model" ||
      next === "provider" ||
      (next === "memoryFlush" && (nested === undefined || nested === "model")))
  );
}

function isProviderAuthRelevantReloadPath(path: string): boolean {
  const segments = path.split(".");
  const [head = "", second, third, fourth] = segments;
  if (PROVIDER_AUTH_RELEVANT_CONFIG_ROOTS.has(head)) {
    return true;
  }
  if (head === "agent" && second === "model") {
    return true;
  }
  if (head !== "agents") {
    return false;
  }
  // Legacy agent rosters are arrays, so any nested change collapses to `agents.list`.
  if (second === undefined || second === "list") {
    return true;
  }
  if (second === "defaults") {
    return isAuthRelevantAgentSubfield(third, segments[3], segments[4]);
  }
  if (second === "entries") {
    return isAuthRelevantAgentSubfield(fourth, segments[4], segments[5]);
  }
  return false;
}

export function reloadPlanNeedsRecovery(plan: GatewayReloadPlan): boolean {
  return (
    plan.restartCron ||
    plan.restartGmailWatcher ||
    plan.reloadPlugins ||
    (plan.restartServices?.size ?? 0) > 0 ||
    plan.restartChannels.size > 0 ||
    (plan.restartChannelAccounts?.size ?? 0) > 0 ||
    shouldRefreshContextWindowCache(plan)
  );
}

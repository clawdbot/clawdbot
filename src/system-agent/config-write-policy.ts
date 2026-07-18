// Path-level write policy for direct system-agent config mutations. The
// dynamic, config-dependent halves (default-agent resolution, plugin route
// ownership) live in operations-execution-helpers.ts; this module owns the
// static classification so the config-write-parity contract test and the
// execution guard share one definition.

/**
 * Config roots the system agent must never write directly, with the operator
 * escalation for each. These stay human-only regardless of approval:
 * credential material, alternate-config inclusion, and provider/catalog
 * definitions that feed inference routing (which has the verified
 * `set_default_model` path instead). Everything else in the schema is
 * agent-writable behind the exact-operation human approval gate — the
 * config-write-parity contract test enforces that classification.
 */
export const SYSTEM_AGENT_CONFIG_WRITE_DENYLIST: Readonly<Record<string, string>> = {
  $include: "alternate-config inclusion; edit openclaw.json in a trusted shell",
  auth: "provider auth; exit OpenClaw and run `openclaw onboard`",
  env: "environment/credential injection; edit openclaw.json in a trusted shell",
  models:
    "provider/catalog definitions feed routing; use `set_default_model` or `openclaw onboard`",
  secrets: "secret providers; edit openclaw.json in a trusted shell",
};

export type InferenceRoutePathVerdict = "allowed" | "blocked" | "agent-route" | "plugin-entry";

export function classifyInferenceRouteConfigPath(
  path: readonly string[],
): InferenceRoutePathVerdict {
  const segments = path.map((segment) => segment.trim().toLowerCase()).filter(Boolean);
  const [root, scope, ownerOrField, field] = segments;
  if (root && root in SYSTEM_AGENT_CONFIG_WRITE_DENYLIST) {
    return "blocked";
  }
  // Plugin enable/disable/config of installed plugins is an operator toggle;
  // install sources and load policy keep their trust boundary in
  // plugin_install (`plugins.entries.*` only). The caller still verifies the
  // entry does not back the active inference route, mirroring plugin_uninstall.
  if (root === "plugins") {
    return scope === "entries" && ownerOrField ? "plugin-entry" : "blocked";
  }
  if (root !== "agents") {
    return "allowed";
  }
  if (!scope || (scope === "defaults" && !ownerOrField) || (scope === "list" && !ownerOrField)) {
    return "blocked";
  }
  if (scope === "defaults") {
    return ["agentruntime", "clibackends", "model", "models", "params"].includes(ownerOrField ?? "")
      ? "blocked"
      : "allowed";
  }
  if (scope !== "list") {
    return "allowed";
  }
  if (/^\d+$/.test(ownerOrField ?? "") && !field) {
    return "blocked";
  }
  const routeField = /^\d+$/.test(ownerOrField ?? "") ? field : ownerOrField;
  // Identity/topology fields stay blocked for every agent; routing fields are
  // blocked only when the entry backs the default (system) inference route —
  // the caller resolves that from the config, since a path cannot tell.
  if (["agentdir", "default", "id"].includes(routeField ?? "")) {
    return "blocked";
  }
  return ["agentruntime", "clibackends", "model", "models", "params"].includes(routeField ?? "")
    ? "agent-route"
    : "allowed";
}

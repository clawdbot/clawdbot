import { normalizeToolPolicyName, normalizeToolPolicyNames } from "../../agents/tool-policy.js";

export function resolveAgentRunToolAllowlist(params: {
  restoredCronToolsAllow?: string[];
  sessionHandoffToolsAllow?: string[];
}): string[] | undefined {
  const restored = params.restoredCronToolsAllow;
  const handoff = params.sessionHandoffToolsAllow;
  if (!restored || !handoff) {
    return restored ?? handoff;
  }
  const restoredNames = normalizeToolPolicyNames(restored);
  return handoff.filter((name) => restoredNames.has(normalizeToolPolicyName(name)));
}

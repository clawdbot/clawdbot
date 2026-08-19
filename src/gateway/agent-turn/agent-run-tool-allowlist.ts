import { isToolAllowedByPolicyNameWithoutAliases } from "../../agents/tool-policy-match.js";

export function resolveAgentRunToolAllowlist(params: {
  restoredCronToolsAllow?: string[];
  sessionHandoffToolsAllow?: string[];
}): string[] | undefined {
  const restored = params.restoredCronToolsAllow;
  const handoff = params.sessionHandoffToolsAllow;
  if (!restored || !handoff) {
    return restored ?? handoff;
  }
  return handoff.filter((name) =>
    isToolAllowedByPolicyNameWithoutAliases(name, { allow: restored }),
  );
}

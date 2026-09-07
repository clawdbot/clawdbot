import {
  createToolPolicyMatcher,
  expandToolGroups,
} from "openclaw/plugin-sdk/agent-harness-runtime";

export function toolListCoversTool(list: readonly string[], tool: string): boolean {
  // Deny matching tests coverage without empty-allow or write/apply_patch compatibility.
  return !createToolPolicyMatcher({ deny: [...list] })(tool);
}

export function expandPolicyToolRequirement(value: string): readonly string[] {
  return expandToolGroups([value]);
}

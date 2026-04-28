import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "./hook-types.js";
import { getActivePluginRegistry } from "./runtime.js";

export async function runTrustedToolPolicies(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<PluginHookBeforeToolCallResult | undefined> {
  const policies = getActivePluginRegistry()?.trustedToolPolicies ?? [];
  let adjustedParams = event.params;
  let hasAdjustedParams = false;
  let approval: PluginHookBeforeToolCallResult["requireApproval"];
  for (const registration of policies) {
    const decision = await registration.policy.evaluate({ ...event, params: adjustedParams }, ctx);
    if (!decision) {
      continue;
    }
    if ("allow" in decision && decision.allow === false) {
      return {
        block: true,
        blockReason: decision.reason ?? `blocked by ${registration.policy.id}`,
      };
    }
    // `block: true` is terminal; normalize a missing blockReason to a deterministic
    // reason so downstream diagnostics match the `{ allow: false }` path above.
    if ("block" in decision && decision.block === true) {
      return {
        ...decision,
        blockReason: decision.blockReason ?? `blocked by ${registration.policy.id}`,
      };
    }
    // `block: false` is a no-op (matches the regular `before_tool_call` hook
    // pipeline) — it does NOT short-circuit the policy chain. Params and
    // approvals are remembered so later trusted policies can still inspect or
    // block the final call.
    if ("params" in decision && decision.params) {
      adjustedParams = decision.params;
      hasAdjustedParams = true;
    }
    if ("requireApproval" in decision && decision.requireApproval && !approval) {
      approval = decision.requireApproval;
    }
  }
  if (!hasAdjustedParams && !approval) {
    return undefined;
  }
  return {
    ...(hasAdjustedParams ? { params: adjustedParams } : {}),
    ...(approval ? { requireApproval: approval } : {}),
  };
}

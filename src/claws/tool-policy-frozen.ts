// Import-free leaf on purpose: `agents/tool-policy.ts` checks this predicate on
// most Gateway/CLI paths, while `tool-policy-runtime.ts` registers runtime-snapshot
// preparers at import time; sharing one module ran that registration everywhere.
const frozenToolAllowPolicies = new WeakSet<object>();

export function markFrozenClawToolAllowPolicy(policy: object | undefined): void {
  if (policy) {
    frozenToolAllowPolicies.add(policy);
  }
}

export function isFrozenClawToolAllowPolicy(policy: object | undefined): boolean {
  return policy ? frozenToolAllowPolicies.has(policy) : false;
}

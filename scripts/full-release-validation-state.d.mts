export * from "./full-release-validation-policy.mjs";
export function validateChildBinding(
  child: Record<string, unknown>,
  run: Record<string, unknown>,
  composite: Record<string, unknown>,
): Record<string, unknown>;
export function parsePlanInputs(value: string): Record<string, unknown>;
export function hydrateReusedPlan(
  plan: Record<string, unknown>[],
  evidence: Record<string, unknown>,
): Record<string, unknown>[];
export function formatReleaseStateHeartbeat(
  mode: string,
  decision: Record<string, unknown>,
): string;

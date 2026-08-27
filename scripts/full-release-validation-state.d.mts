export * from "./full-release-validation-policy.mjs";
export function validateChildBinding(
  child: Record<string, unknown>,
  run: Record<string, unknown>,
  composite: Record<string, unknown>,
): Record<string, unknown>;
export function readChild(
  child: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  options?: {
    readAttemptJobs?: (
      runId: string,
      runAttempt: number,
      signal?: AbortSignal,
    ) => Promise<Record<string, unknown>[]>;
    readRun?: (runId: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;
    transientGracePolls?: number;
  },
): Promise<Record<string, unknown>>;
export function parsePlanInputs(value: string): Record<string, unknown>;
export function hydrateReusedPlan(
  plan: Record<string, unknown>[],
  evidence: Record<string, unknown>,
): Record<string, unknown>[];
export function formatReleaseStateHeartbeat(
  mode: string,
  decision: Record<string, unknown>,
): string;

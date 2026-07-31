import type { FailoverReason } from "../agents/embedded-agent-helpers/types.js";
import { resolveFailoverReasonFromError } from "../agents/failover-error.js";
import type { CronRunErrorClassification } from "./types.js";

/** Resolve one cron-owned classification before falling back to provider error inference. */
export function resolveCronRunErrorReason(
  error: unknown,
  provider?: string,
  classification?: CronRunErrorClassification,
): FailoverReason | undefined {
  if (classification?.kind === "permanent") {
    return undefined;
  }
  if (classification?.kind === "reason") {
    return classification.reason;
  }
  return resolveFailoverReasonFromError(error, provider) ?? undefined;
}

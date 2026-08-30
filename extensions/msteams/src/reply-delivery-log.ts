import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";

export function logMSTeamsPartialDeliveryFailure(params: {
  log: MSTeamsMonitorLogger;
  failed: number;
  total: number;
  error: unknown;
}): void {
  const classification = classifyMSTeamsSendError(params.error);
  const hint = formatMSTeamsSendErrorHint(classification);
  params.log.warn?.(`failed to deliver ${params.failed} of ${params.total} message blocks`, {
    failed: params.failed,
    total: params.total,
    error: formatUnknownError(params.error),
    classification,
    ...(hint ? { hint } : {}),
  });
}

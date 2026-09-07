import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createPanelRefreshStatus,
  failPanelRefresh,
  type PanelRefreshStatus,
} from "../../components/panel-refresh-status.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";

type UsageDetailRefreshFailure = {
  clearData: boolean;
  status: PanelRefreshStatus;
};

export function failUsageDetailRefresh(
  status: PanelRefreshStatus,
  error: unknown,
  gateway: ApplicationGatewaySnapshot | null,
): UsageDetailRefreshFailure {
  const clearData = isMissingOperatorReadScopeError(error);
  const failed = failPanelRefresh(clearData ? createPanelRefreshStatus() : status, error, gateway);
  return {
    clearData,
    status:
      clearData && failed.error
        ? { ...failed, error: formatMissingOperatorReadScopeMessage("usage details") }
        : failed,
  };
}

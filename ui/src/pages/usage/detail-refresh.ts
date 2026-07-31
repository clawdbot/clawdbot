import {
  createPanelRefreshStatus,
  failPanelRefresh,
  type PanelRefreshStatus,
} from "../../components/panel-refresh-status.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { toUsageErrorMessage } from "./helpers.ts";

type UsageDetailRefreshFailure = {
  clearData: boolean;
  status: PanelRefreshStatus;
};

export function failUsageDetailRefresh(
  status: PanelRefreshStatus,
  error: unknown,
): UsageDetailRefreshFailure {
  if (isMissingOperatorReadScopeError(error)) {
    return {
      clearData: true,
      status: failPanelRefresh(
        createPanelRefreshStatus(),
        formatMissingOperatorReadScopeMessage("usage details"),
      ),
    };
  }
  return {
    clearData: false,
    status: failPanelRefresh(status, toUsageErrorMessage(error)),
  };
}

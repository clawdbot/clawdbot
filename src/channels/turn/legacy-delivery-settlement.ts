import {
  markModelSpendAlertsDeliveredBestEffort,
  markModelSpendAlertsUnknownBestEffort,
} from "../../agents/model-spend-alert-delivery.js";
import {
  releasePreparedModelSpendAlertsBestEffort,
  type ModelSpendAlertCompletion,
} from "../../agents/model-spend-alerts.js";
import { isChannelPartialDeliveryError } from "./delivery-result.js";
import type { ChannelDeliveryOutcome, ChannelDeliveryResult } from "./types.js";

export function isExplicitlyNonVisibleChannelDelivery(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { visibleReplySent?: unknown }).visibleReplySent === false
  );
}

function settleLegacyModelSpendAlert(
  completion: ModelSpendAlertCompletion,
  result: ChannelDeliveryOutcome | void,
): void {
  if (isExplicitlyNonVisibleChannelDelivery(result)) {
    releasePreparedModelSpendAlertsBestEffort(completion);
    return;
  }
  markModelSpendAlertsDeliveredBestEffort(completion);
}

export function settleLegacyModelSpendAlertError(
  completion: ModelSpendAlertCompletion,
  error: unknown,
): void {
  const visible =
    isChannelPartialDeliveryError(error) ||
    (typeof error === "object" &&
      error !== null &&
      !Array.isArray(error) &&
      ((error as { sentBeforeError?: unknown }).sentBeforeError === true ||
        (error as { visibleReplySent?: unknown }).visibleReplySent === true));
  if (visible) {
    // Partial visibility does not prove that the trailing alert text reached the provider.
    // Keep the claim terminal to avoid a blind duplicate on the next owner reply.
    markModelSpendAlertsUnknownBestEffort(completion);
    return;
  }
  releasePreparedModelSpendAlertsBestEffort(completion);
}

export function attachLegacyModelSpendAlertSettlement(
  completion: ModelSpendAlertCompletion,
  result: ChannelDeliveryResult | void,
): ChannelDeliveryResult | void {
  if (!result?.finalization) {
    settleLegacyModelSpendAlert(completion, result);
    return result;
  }
  return {
    ...result,
    finalization: result.finalization.then(
      (finalized) => {
        settleLegacyModelSpendAlert(completion, finalized);
        return finalized;
      },
      (error: unknown) => {
        settleLegacyModelSpendAlertError(completion, error);
        throw error;
      },
    ),
  };
}

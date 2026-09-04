import type { PlacementComposerPresentation } from "./chat-pane-placement.ts";
import type {
  ChatComposerDisabledBanner,
  ChatComposerProps,
} from "./components/chat-composer-types.ts";

type ComposerAvailability = Pick<
  ChatComposerProps,
  "canSend" | "disabledReason" | "disabledReasonTone" | "disabledReasonBusy" | "disabledBanner"
>;

export function resolveComposerAvailability(params: {
  catalog: boolean;
  catalogCanSend: boolean;
  catalogDisabledReason: string | null;
  modelSetupRequired: boolean;
  baseDisabledReason: string | null;
  baseDisabledReasonTone: "info" | "danger";
  selectedSessionArchived: boolean;
  restartRecoveryTombstoned: boolean;
  placement: PlacementComposerPresentation;
  sendHoldReason: string | null;
  placementStartupPending: boolean;
  sessionDisabledBanner: ChatComposerDisabledBanner | undefined;
}): ComposerAvailability {
  const placementFailureReason =
    params.placement.state.kind === "failed" && !params.placement.state.recoveryAction
      ? params.placement.failedUnavailableMessage
      : null;
  return {
    canSend: params.catalog
      ? params.catalogCanSend
      : !params.modelSetupRequired &&
        !params.baseDisabledReason &&
        !params.selectedSessionArchived &&
        !params.restartRecoveryTombstoned &&
        !params.placement.blocksSend &&
        !params.sendHoldReason,
    disabledReason:
      params.catalogDisabledReason ??
      params.baseDisabledReason ??
      params.placement.busyMessage ??
      placementFailureReason ??
      (params.placementStartupPending ? null : params.sendHoldReason),
    disabledReasonTone: params.placement.busyMessage ? "info" : params.baseDisabledReasonTone,
    disabledReasonBusy: params.placement.busyMessage !== null,
    disabledBanner: params.sessionDisabledBanner ?? params.placement.disabledBanner,
  };
}

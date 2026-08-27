import { asOptionalRecord as asResultRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { isChannelPartialDeliveryError } from "../../channels/turn/delivery-result.js";
import { isOutboundDeliveryError } from "./deliver-types.js";
import { projectPluginMessageDelivery } from "./plugin-message-delivery.js";
import {
  beginCapturedHeartbeatMessageToolProjection,
  beginCapturedHeartbeatOpaquePluginRouteProjection,
  captureTargetSessionProjection,
  recordTargetSessionProjectionDeliveredPayload,
} from "./target-session-projection.js";

type TargetSessionCaptureParams = Parameters<typeof captureTargetSessionProjection>[0];

function hasGatewayPartialDeliveryReceipt(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const requestError = asResultRecord(error);
  if (requestError?.gatewayCode !== ErrorCodes.UNAVAILABLE || requestError.retryable !== false) {
    return false;
  }
  const details = asResultRecord(requestError.details);
  return asResultRecord(details?.partialDelivery)?.visibleReplySent === true;
}

/** Owns heartbeat-only bookkeeping after a message action crosses the send boundary. */
export function createMessageActionTargetSessionBookkeeping(params: {
  requested: boolean;
  capture?: TargetSessionCaptureParams;
  commitOrdinaryRoute: () => Promise<void>;
}) {
  const selection = params.requested
    ? params.capture
      ? captureTargetSessionProjection(params.capture)
      : { status: "unavailable" as const }
    : { status: "ordinary" as const };
  const capture = selection.status === "captured" ? selection.capture : undefined;
  const deferred = selection.status !== "ordinary";
  const begin = (partialDelivery: boolean) => {
    beginCapturedHeartbeatMessageToolProjection({ capture, partialDelivery });
  };
  const beginPartialForError = (error: unknown, confirmedPartial = false) => {
    if (
      capture &&
      (confirmedPartial ||
        capture.deliveredPayloads.length > 0 ||
        isChannelPartialDeliveryError(error) ||
        (isOutboundDeliveryError(error) && error.sentBeforeError))
    ) {
      begin(true);
    }
  };
  return {
    deferred,
    recordDeliveredPayload: (
      payload: Parameters<typeof recordTargetSessionProjectionDeliveredPayload>[1],
    ) => recordTargetSessionProjectionDeliveredPayload(capture, payload),
    begin,
    beginPartialForError,
    beginGatewayError: (error: unknown, connectionTarget: "local" | "remote" | undefined) => {
      if (connectionTarget === "local") {
        beginPartialForError(error, hasGatewayPartialDeliveryReceipt(error));
      }
    },
    commitPlugin: async (payload: unknown) => {
      if (selection.status === "ordinary") {
        await params.commitOrdinaryRoute();
        return;
      }
      if (!capture) {
        return;
      }
      const delivery = projectPluginMessageDelivery(payload);
      if (delivery?.status === "settled") {
        begin(delivery.partialDelivery);
      } else if (!delivery) {
        // Opaque acceptance preserves only the route; it cannot prove exact
        // transcript or awareness content.
        beginCapturedHeartbeatOpaquePluginRouteProjection(capture);
      }
    },
  };
}

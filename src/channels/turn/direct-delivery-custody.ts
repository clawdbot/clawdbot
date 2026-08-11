import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import type { ChannelDeliveryInfo } from "./types.js";

type DirectPendingFinalCustody = Pick<ChannelDeliveryInfo, "bindPendingFinalDelivery"> & {
  onPlatformSendDispatch: () => Promise<void>;
};

export const NO_PENDING_FINAL_CUSTODY: DirectPendingFinalCustody = {
  onPlatformSendDispatch: () => Promise.resolve(),
};

export function resolvePendingFinalCompletion(payload: ReplyPayload) {
  const identity = getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion;
  return identity ? { kind: "pending-final" as const, ...identity } : undefined;
}

export function createDirectPendingFinalCustody(
  payload: ReplyPayload,
): DirectPendingFinalCustody | undefined {
  const completion = resolvePendingFinalCompletion(payload);
  if (!completion) {
    return undefined;
  }
  const { kind: _kind, ...identity } = completion;
  let admission: Promise<void> | undefined;
  return {
    bindPendingFinalDelivery: (nextPayload) =>
      setReplyPayloadMetadata(nextPayload, {
        pendingFinalDeliveryCompletion: identity,
      }),
    onPlatformSendDispatch: () => {
      admission ??= settlePendingFinalDelivery(completion, "unknown", ["prepared", "queued"]).then(
        (result) => {
          if (result.state !== "unknown") {
            throw new PlatformMessageNotDispatchedError(
              "Pending final delivery ownership changed before platform dispatch",
              { cause: new Error(`pending final delivery is ${result.state}`) },
            );
          }
        },
      );
      return admission;
    },
  };
}

export function toCoreManagedDeliveryInfo(info: ChannelDeliveryInfo) {
  return {
    kind: info.kind,
    ...(info.assistantMessageIndex === undefined
      ? {}
      : { assistantMessageIndex: info.assistantMessageIndex }),
  };
}

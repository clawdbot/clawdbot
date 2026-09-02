import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { assertReplyPayloadSessionWriterDeliveryAuthorized } from "../../auto-reply/reply/session-writer-delivery-authority.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import type { ChannelDeliveryInfo } from "./types.js";

type DirectPendingFinalCustody = Pick<ChannelDeliveryInfo, "bindPendingFinalDelivery"> & {
  assertPlatformSendAuthorized: () => void;
  onPlatformSendDispatch: () => Promise<void>;
};

export const NO_PENDING_FINAL_CUSTODY: DirectPendingFinalCustody = {
  assertPlatformSendAuthorized: () => undefined,
  onPlatformSendDispatch: () => Promise.resolve(),
};

export function resolvePendingFinalCompletion(payload: ReplyPayload) {
  const identity = getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion;
  return identity ? { kind: "pending-final" as const, ...identity } : undefined;
}

export function createDirectPendingFinalCustody(
  payload: ReplyPayload,
  fallbackStorePath?: string,
): DirectPendingFinalCustody | undefined {
  const completion = resolvePendingFinalCompletion(payload);
  const hasWriterAuthority = Boolean(
    getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority,
  );
  if (!completion && !hasWriterAuthority) {
    return undefined;
  }
  const identity = completion ? (({ kind: _kind, ...value }) => value)(completion) : undefined;
  let firstDispatch = true;
  let admissionTail = Promise.resolve();
  return {
    bindPendingFinalDelivery: (nextPayload) =>
      identity
        ? setReplyPayloadMetadata(nextPayload, {
            pendingFinalDeliveryCompletion: identity,
          })
        : nextPayload,
    assertPlatformSendAuthorized: () =>
      assertReplyPayloadSessionWriterDeliveryAuthorized(payload, fallbackStorePath),
    onPlatformSendDispatch: () => {
      const expectedStates = firstDispatch
        ? (["prepared", "queued"] as const)
        : (["unknown"] as const);
      firstDispatch = false;
      const admission = admissionTail.then(async () => {
        assertReplyPayloadSessionWriterDeliveryAuthorized(payload, fallbackStorePath);
        if (!completion) {
          return;
        }
        const result = await settlePendingFinalDelivery(completion, "unknown", expectedStates);
        if (result.state !== "unknown") {
          throw new PlatformMessageNotDispatchedError(
            "Pending final delivery ownership changed before platform dispatch",
            { cause: new Error(`pending final delivery is ${result.state}`) },
          );
        }
      });
      // Every physical post must observe the state left by the prior post's check.
      admissionTail = admission.catch(() => undefined);
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

import { emitContinuationFanoutSpan } from "../../infra/continuation-tracer.js";
import {
  markTrustedContinuationHeartbeatWake,
  requestHeartbeatNow,
} from "../../infra/heartbeat-wake.js";
import {
  ackSessionDelivery,
  enqueueSessionDelivery,
} from "../../infra/session-delivery-queue-storage.js";
import type { SessionDeliveryContext } from "../../infra/session-delivery-queue-storage.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  hasContinuationDelegateTargeting,
  hasCrossSessionDelegateTargeting,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting-pure.js";
import type {
  ContinuationCrossSessionTargetingPolicy,
  ContinuationDelegateFanoutMode,
  ContinuationDelegateTargeting,
} from "./targeting-pure.js";

export {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  hasContinuationDelegateTargeting,
  hasCrossSessionDelegateTargeting,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
};
export type {
  ContinuationCrossSessionTargetingPolicy,
  ContinuationDelegateFanoutMode,
  ContinuationDelegateTargeting,
};

export function resolveContinuationReturnTargetSessionKeys(
  params: ContinuationDelegateTargeting & {
    defaultSessionKey: string;
    treeSessionKeys?: readonly string[];
    allSessionKeys?: readonly string[];
    childSessionKey?: string;
  },
): string[] {
  const defaultSessionKey = normalizeContinuationTargetKey(params.defaultSessionKey);
  const fallback = defaultSessionKey ? [defaultSessionKey] : [];

  if (params.fanoutMode === "tree") {
    const treeKeys = normalizeContinuationTargetKeys(params.treeSessionKeys);
    return treeKeys.length > 0 ? treeKeys : fallback;
  }

  if (params.fanoutMode === "all") {
    const childSessionKey = normalizeContinuationTargetKey(params.childSessionKey);
    const allKeys = normalizeContinuationTargetKeys(params.allSessionKeys).filter(
      (sessionKey) => sessionKey !== childSessionKey,
    );
    return allKeys.length > 0 ? allKeys : fallback;
  }

  const explicitKeys = normalizeContinuationTargetKeys([
    ...(params.targetSessionKey ? [params.targetSessionKey] : []),
    ...(params.targetSessionKeys ?? []),
  ]);
  return explicitKeys.length > 0 ? explicitKeys : fallback;
}

type ContinuationReturnDeliveryDeps = {
  enqueueSessionDelivery: typeof enqueueSessionDelivery;
  ackSessionDelivery: typeof ackSessionDelivery;
  enqueueSystemEvent: typeof enqueueSystemEvent;
  requestHeartbeatNow: typeof requestHeartbeatNow;
};

const defaultContinuationReturnDeliveryDeps: ContinuationReturnDeliveryDeps = {
  enqueueSessionDelivery,
  ackSessionDelivery,
  enqueueSystemEvent,
  requestHeartbeatNow,
};

export async function enqueueContinuationReturnDeliveries(
  params: {
    targetSessionKeys: readonly string[];
    text: string;
    idempotencyKeyBase: string;
    deliveryContext?: SessionDeliveryContext;
    wakeRecipients?: boolean;
    childRunId?: string;
    stateDir?: string;
    traceparent?: string;
    fanoutMode?: ContinuationDelegateFanoutMode;
    chainStepRemaining?: number;
  },
  deps: ContinuationReturnDeliveryDeps = defaultContinuationReturnDeliveryDeps,
): Promise<{ enqueued: number; delivered: number; deliveryIds: string[] }> {
  const targetSessionKeys = normalizeContinuationTargetKeys(params.targetSessionKeys);
  const deliveryIds: string[] = [];
  let delivered = 0;

  for (const sessionKey of targetSessionKeys) {
    const deliveryId = await deps.enqueueSessionDelivery(
      {
        kind: "systemEvent",
        sessionKey,
        text: params.text,
        ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
        ...(params.traceparent ? { traceparent: params.traceparent } : {}),
        // Recipient position is not stable when a cleaned intermediate is
        // removed from a tree/all fanout.  Keep retries keyed to the durable
        // recipient identity instead.
        idempotencyKey: `${params.idempotencyKeyBase}:${sessionKey}`,
      },
      params.stateDir,
    );
    deliveryIds.push(deliveryId);

    const enqueued = deps.enqueueSystemEvent(params.text, {
      sessionKey,
      trusted: true,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      ...(params.traceparent ? { traceparent: params.traceparent } : {}),
      sessionDeliveryAckId: deliveryId,
      ...(params.stateDir ? { sessionDeliveryAckStateDir: params.stateDir } : {}),
    });
    if (!enqueued) {
      // Idempotent delivery enqueue can return the existing durable row id for
      // the already-queued in-memory event. Do not ack here: that would delete
      // the durable backing row for the surviving queued event before the
      // prompt-drain path consumes it. The surviving event carries the ack id.
    }
    if (params.wakeRecipients) {
      deps.requestHeartbeatNow(
        markTrustedContinuationHeartbeatWake({
          sessionKey,
          reason: "delegate-return",
          parentRunId: params.childRunId,
        }),
      );
    }
    // For a queued event, do NOT ack the durable file here. The in-memory event
    // carries the ack id and the prompt-drain path acknowledges it only after
    // recipient consumption; non-attached recipients still need restart recovery
    // to replay this file.
    delivered += 1;
  }

  if (
    (params.traceparent !== undefined || params.chainStepRemaining !== undefined) &&
    (params.fanoutMode !== undefined || targetSessionKeys.length > 1)
  ) {
    emitContinuationFanoutSpan({
      targetSessionKeys,
      deliveredCount: delivered,
      ...(params.fanoutMode ? { fanoutMode: params.fanoutMode } : {}),
      ...(params.chainStepRemaining !== undefined
        ? { chainStepRemaining: params.chainStepRemaining }
        : {}),
      ...(params.traceparent ? { traceparent: params.traceparent } : {}),
    });
  }

  return {
    enqueued: deliveryIds.length,
    delivered,
    deliveryIds,
  };
}

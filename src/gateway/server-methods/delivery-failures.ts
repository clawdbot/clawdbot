import {
  type DeliveryFailureResubmitReason,
  type DeliveryFailureResubmitResult,
  validateDeliveryFailureResubmitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getDeliveryQueueEntryStatus } from "../../infra/delivery-queue-sqlite.js";
import { resubmitOutboundDelivery } from "../../infra/outbound/delivery-queue-failures.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-media-staging.js";
import {
  findDeliveryIntentOwners,
  OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS,
} from "../../infra/outbound/delivery-queue-storage.js";
import { scheduleSessionDelivery } from "../../infra/session-delivery-queue-runtime.js";
import {
  resubmitSessionDelivery,
  SESSION_DELIVERY_QUEUE_NAME,
} from "../../infra/session-delivery-queue-storage.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function refused(
  reason: DeliveryFailureResubmitReason,
  queueName?: string,
): DeliveryFailureResubmitResult {
  return {
    ok: false,
    ...(queueName ? { queueName } : {}),
    reason,
  };
}

function resolveQueue(id: string, requestedQueueName?: string) {
  if (requestedQueueName === SESSION_DELIVERY_QUEUE_NAME) {
    return { kind: "session" as const, queueName: requestedQueueName };
  }
  if (requestedQueueName === OUTBOUND_DELIVERY_QUEUE_NAME) {
    const outboundOwners = findDeliveryIntentOwners(id);
    if (outboundOwners.length > 1) {
      return refused("ambiguous_queue");
    }
    const outboundOwner = outboundOwners[0];
    if (outboundOwner?.retired) {
      return refused("migration_namespace", outboundOwner.queueName);
    }
    return { kind: "outbound" as const, queueName: requestedQueueName };
  }
  if (requestedQueueName) {
    return OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS.some(
      (descriptor) => descriptor.retired && descriptor.queueName === requestedQueueName,
    )
      ? refused("migration_namespace", requestedQueueName)
      : refused("unsupported_queue", requestedQueueName);
  }
  const sessionStatus = getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id);
  const outboundOwners = findDeliveryIntentOwners(id);
  if (sessionStatus && outboundOwners.length > 0) {
    return refused("ambiguous_queue");
  }
  if (outboundOwners.length > 1) {
    return refused("ambiguous_queue");
  }
  const outboundOwner = outboundOwners[0];
  if (!outboundOwner) {
    return { kind: "session" as const, queueName: SESSION_DELIVERY_QUEUE_NAME };
  }
  if (outboundOwner.retired) {
    return refused("migration_namespace", outboundOwner.queueName);
  }
  return { kind: "outbound" as const, queueName: OUTBOUND_DELIVERY_QUEUE_NAME };
}

export const deliveryFailureHandlers: GatewayRequestHandlers = {
  "delivery.failures.resubmit": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateDeliveryFailureResubmitParams,
        "delivery.failures.resubmit",
        respond,
      )
    ) {
      return;
    }
    const target = resolveQueue(params.id, params.queueName);
    if (!("kind" in target)) {
      respond(true, target, undefined);
      return;
    }
    if (target.kind === "outbound") {
      const resubmit = await resubmitOutboundDelivery(params.id);
      const result: DeliveryFailureResubmitResult = resubmit.ok
        ? {
            ok: true,
            queueName: target.queueName,
            disposition: "queued_for_recovery",
          }
        : refused(resubmit.reason, target.queueName);
      respond(true, result, undefined);
      return;
    }
    const resubmit = await resubmitSessionDelivery(params.id);
    if (!resubmit.ok) {
      respond(true, refused(resubmit.reason, target.queueName), undefined);
      return;
    }
    let scheduled = false;
    try {
      scheduled = await scheduleSessionDelivery(params.id);
    } catch {
      // The failed-to-pending transition already committed. Startup recovery remains authoritative.
    }
    const result: DeliveryFailureResubmitResult = scheduled
      ? {
          ok: true,
          queueName: target.queueName,
          disposition: "scheduled",
        }
      : {
          ok: true,
          queueName: target.queueName,
          disposition: "queued_for_startup",
        };
    respond(true, result, undefined);
  },
};

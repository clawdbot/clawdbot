// Physical outbound queue namespaces and exact-ID ownership lookup.
import {
  getDeliveryQueueEntryStatus,
  getDeliveryQueueEntryStatuses,
} from "../delivery-queue-sqlite.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";

export const OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS = [
  { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, namespace: "prepared", retired: false },
  { queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME, namespace: "preparing", retired: true },
  { queueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, namespace: "migration", retired: true },
  {
    queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    namespace: "legacy-preparing",
    retired: true,
  },
  { queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, namespace: "legacy", retired: true },
] as const;

type DeliveryIntentOwner = (typeof OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS)[number] & {
  status: "pending" | "failed" | "completed";
};

/** Returns every physical namespace that still owns an exact outbound delivery ID. */
export function findDeliveryIntentOwners(id: string, stateDir?: string): DeliveryIntentOwner[] {
  const statuses = getDeliveryQueueEntryStatuses(
    OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS.map((descriptor) => descriptor.queueName),
    id,
    stateDir,
  );
  return OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS.flatMap((descriptor) => {
    const status = statuses.get(descriptor.queueName);
    return status ? [{ ...descriptor, status }] : [];
  });
}

export function findDeliveryIntentOwner(id: string, stateDir?: string): DeliveryIntentOwner | null {
  for (const descriptor of OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS) {
    const status = getDeliveryQueueEntryStatus(descriptor.queueName, id, stateDir);
    if (status) {
      return { ...descriptor, status };
    }
  }
  return null;
}

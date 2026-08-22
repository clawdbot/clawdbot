// Delivery queue runtime helpers persist and replay outbound plugin delivery work.
import {
  drainPendingDeliveriesCore,
  type DeliverFn,
} from "../infra/outbound/delivery-queue-recovery.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

type DrainPendingDeliveriesOptions = Omit<
  Parameters<typeof drainPendingDeliveriesCore>[0],
  "deliver"
> & {
  /** Optional delivery implementation for tests or plugin-owned send paths. */
  deliver?: DeliverFn;
};

const loadOutboundDeliverRuntime = createLazyRuntimeModule(
  () => import("../infra/outbound/deliver-runtime.js"),
);

/**
 * Drain queued outbound payloads after a channel reconnect or transport recovery.
 * When no deliver function is provided, the heavy outbound delivery runtime is
 * loaded lazily so importing this SDK subpath does not eagerly bind send internals.
 */
export async function drainPendingDeliveries(opts: DrainPendingDeliveriesOptions): Promise<void> {
  await runWithGatewayIndependentRootWorkAdmission(async () => {
    // Keep lazy resolution and draining in one lease so suspension cannot split the handoff.
    const deliver =
      opts.deliver ?? (await loadOutboundDeliverRuntime()).deliverOutboundPayloadsInternal;
    await drainPendingDeliveriesCore({
      ...opts,
      deliver,
      // Conversation records belong to the Gateway recovery loop, which reconstructs current
      // route authority before delivery. Plugin reconnect drains cannot safely consume them.
      selectEntry: (entry, now) =>
        entry.deliveryCompletion?.kind === "conversation"
          ? { match: false, bypassBackoff: false }
          : opts.selectEntry(entry, now),
    });
  });
}

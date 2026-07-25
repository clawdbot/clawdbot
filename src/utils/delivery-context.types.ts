// Delivery context types describe normalized channel route delivery inputs.
import type { ChannelRouteTargetInput } from "../plugin-sdk/channel-route.js";

/** Deferred outbound delivery intent attached to a session or task. */
type DeliveryIntentRef = {
  /** Stable queue/work item id. */
  id: string;
  /** Intent family; currently scoped to outbound queue delivery. */
  kind: "outbound_queue";
  /** Whether queueing is mandatory or best-effort for this delivery. */
  queuePolicy?: "required" | "best_effort";
};

/** Canonical channel delivery target shared by sessions, cron, tasks, and plugins. */
export type DeliveryContext = Pick<
  ChannelRouteTargetInput,
  "accountId" | "channel" | "threadId" | "to"
> & {
  /** Channel/plugin id that owns the delivery target. */
  channel?: string;
  /** Channel-local destination id, preserved with channel-specific casing. */
  to?: string;
  /** Optional channel account/workspace id. */
  accountId?: string;
  /** Optional thread/topic id nested under `to`. */
  threadId?: string | number;
  /** Optional queued-delivery intent associated with this context. */
  deliveryIntent?: DeliveryIntentRef;
};

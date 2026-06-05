// Delivery context types describe normalized channel route delivery inputs.
import type { ChannelRouteRef, ChannelRouteTargetInput } from "../plugin-sdk/channel-route.js";

/** Deferred outbound delivery intent attached to a session or task. */
export type DeliveryIntentRef = {
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

/** Mixed legacy and modern session fields used to reconstruct a delivery context. */
export type DeliveryContextSessionSource = {
  /** Modern SDK route metadata, preferred when present and routable. */
  route?: ChannelRouteRef;
  /** Original/current session channel; may be an internal channel such as webchat. */
  channel?: string;
  /** Legacy mirrored delivery channel. */
  lastChannel?: string;
  /** Legacy mirrored delivery target. */
  lastTo?: string;
  /** Legacy mirrored account/workspace id. */
  lastAccountId?: string;
  /** Legacy mirrored thread/topic id. */
  lastThreadId?: string | number;
  /** Older origin fields emitted before delivery context became canonical. */
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  /** Canonical delivery context stored on newer session records. */
  deliveryContext?: DeliveryContext;
};

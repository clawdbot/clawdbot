/** Stable cron run-history wire shape and legacy JSONL migration input. */
import type { CronRunLogEntry as CronRunLogWireEntry } from "../../packages/gateway-protocol/src/schema/cron.types.js";
import type { NormalizeReplySkipReason } from "../auto-reply/reply/normalize-reply-skip-reason.js";

/** Run-history record for a completed cron job execution. */
export type CronRunLogEntry = Omit<CronRunLogWireEntry, "deliverySuppressionReason"> & {
  deliverySuppressionReason?: NormalizeReplySkipReason;
};

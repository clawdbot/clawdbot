import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  NodeHostStatsPayloadSchema,
  type NodeHostStatsPayload,
} from "../../packages/gateway-protocol/src/schema/nodes.js";

export const NODE_HOST_STATS_EVENT = "node.host.stats";
export const NODE_HOST_STATS_INTERVAL_MS = 60_000;

export type NodeHostStats = NodeHostStatsPayload & { updatedAtMs: number };

/** Validate a saved or projected snapshot without replacing its Gateway receipt time. */
export function isNodeHostStats(value: unknown): value is NodeHostStats {
  if (!isRecord(value)) {
    return false;
  }
  const { updatedAtMs, ...stats } = value;
  return (
    typeof updatedAtMs === "number" &&
    Number.isSafeInteger(updatedAtMs) &&
    updatedAtMs >= 0 &&
    Value.Check(NodeHostStatsPayloadSchema, stats)
  );
}

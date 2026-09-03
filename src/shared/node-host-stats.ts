import type { NodeHostStatsPayload } from "../../packages/gateway-protocol/src/schema/nodes.js";

export const NODE_HOST_STATS_EVENT = "node.host.stats";
export const NODE_HOST_STATS_INTERVAL_MS = 60_000;

export type NodeHostStats = NodeHostStatsPayload & { updatedAtMs: number };

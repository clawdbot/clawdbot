/**
 * Cron-backed task-lane provider. Projects the most recent N run log entries
 * into a single lane so the Automations pane surfaces cron activity without
 * any cross-module coupling beyond the read-only `readCronTaskRunHistoryPage`
 * API.
 */

import { readCronTaskRunHistoryPage } from "../../cron/task-run-history.js";
import type { TaskLane, TaskLaneItem, TaskLaneProvider } from "../types.js";
import { truncateTaskLaneText } from "../types.js";
import {
  TASK_LANE_MAX_ITEMS_PER_LANE,
  TASK_LANE_MAX_OUTCOME_CHARS,
  TASK_LANE_MAX_TITLE_CHARS,
} from "../types.js";

const CRON_LANE_ID = "cron";
const CRON_LANE_LABEL = "Cron runs";

export type CronBackedProviderOptions = {
  /** Canonical cron store partition key (`cronStoreKey(storePath)`). Required. */
  storeKey: string;
  /** Maximum items to surface; bounded by the lane item cap. */
  limit?: number;
  /** Agent scope filter; omit for all agents. */
  agentId?: string;
  /** Optional jobId → jobName map for item titles; falls back to jobId. */
  jobNameById?: Record<string, string>;
};

/** Maps the persisted CronRunStatus vocabulary onto lane item states. */
function deriveItemState(status: unknown): TaskLaneItem["state"] {
  if (status === "ok") {
    return "succeeded";
  }
  if (status === "error") {
    return "failed";
  }
  if (status === "skipped") {
    return "canceled";
  }
  return "unknown";
}

/**
 * Builds a task-lane provider that surfaces the most recent cron run log
 * entries as a single "Cron runs" lane. Read-only, no plugin involvement.
 * `readCronTaskRunHistoryPage` is synchronous; `storeKey` selects the SQLite
 * partition and must match the gateway's cron store path.
 */
export function createCronBackedProvider(
  id: string,
  options: CronBackedProviderOptions,
): TaskLaneProvider {
  return {
    id,
    label: CRON_LANE_LABEL,
    async load(): Promise<{ lanes: TaskLane[] }> {
      const limit = Math.min(Math.max(options.limit ?? 20, 1), TASK_LANE_MAX_ITEMS_PER_LANE);
      const page = readCronTaskRunHistoryPage({
        storeKey: options.storeKey,
        limit,
        offset: 0,
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.jobNameById ? { jobNameById: options.jobNameById } : {}),
      });
      const items: TaskLaneItem[] = [];
      for (const entry of page.entries) {
        if (items.length >= limit) {
          break;
        }
        const startedAtMs =
          typeof entry.runAtMs === "number" && Number.isFinite(entry.runAtMs)
            ? entry.runAtMs
            : entry.ts;
        items.push({
          id: entry.runId ?? `${entry.jobId}:${entry.ts}`,
          title: truncateTaskLaneText(
            options.jobNameById?.[entry.jobId] ?? entry.jobId,
            TASK_LANE_MAX_TITLE_CHARS,
          ),
          state: deriveItemState(entry.status),
          startedAtMs,
          ...(entry.completionCause
            ? {
                outcome: truncateTaskLaneText(
                  String(entry.completionCause),
                  TASK_LANE_MAX_OUTCOME_CHARS,
                ),
              }
            : {}),
        });
      }
      const lane: TaskLane = {
        id: CRON_LANE_ID,
        label: CRON_LANE_LABEL,
        items,
      };
      return { lanes: [lane] };
    },
  };
}

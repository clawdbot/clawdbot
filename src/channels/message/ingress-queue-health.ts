/** Redacted health diagnostics for durable channel ingress queues. */
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { INGRESS_CLAIM_LEASE_MS } from "./ingress-claim-owner.js";
import { getChannelIngressKysely, openChannelIngressDatabase } from "./ingress-queue.js";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "./ingress-retry-policy.js";

/** Count failed channel ingress events per channel account for operator health surfaces. */
export function countFailedChannelIngressQueueEntries(stateDir?: string) {
  const database = openChannelIngressDatabase(stateDir);
  const queueDb = getChannelIngressKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom("channel_ingress_events")
      .select((eb) => [
        "channel_id as channelId",
        "account_id as accountId",
        eb.fn.countAll<number>().as("count"),
        eb.fn.min<number>("failed_at").as("oldestFailedAt"),
      ])
      .where("status", "=", "failed")
      .groupBy(["channel_id", "account_id"])
      .orderBy("channel_id", "asc")
      .orderBy("account_id", "asc"),
  ).rows;
  return rows.map(({ oldestFailedAt, ...row }) =>
    oldestFailedAt == null ? row : Object.assign(row, { oldestFailedAt }),
  );
}

/** Aggregate active lanes whose retry or claim state can block later ingress. */
export function countChannelIngressQueuePressure(stateDir?: string) {
  const database = openChannelIngressDatabase(stateDir);
  const queueDb = getChannelIngressKysely(database.db);
  const staleClaimCutoff = Date.now() - INGRESS_CLAIM_LEASE_MS;
  const laneTotals = queueDb
    .selectFrom("channel_ingress_events")
    .select((eb) => [
      "channel_id",
      "account_id",
      eb.fn.countAll<number>().as("activeCount"),
      eb.fn.countAll<number>().filterWhere("status", "=", "pending").as("pendingCount"),
      eb.fn.countAll<number>().filterWhere("status", "=", "claimed").as("claimedCount"),
      eb.fn.min<number>("received_at").as("oldestReceivedAt"),
    ])
    .where("status", "in", ["pending", "claimed"])
    .where("lane_key", "is not", null)
    .groupBy(["queue_name", "lane_key", "channel_id", "account_id"])
    .having((eb) =>
      eb.or([
        eb(
          eb.fn
            .countAll<number>()
            .filterWhere((filter) =>
              filter.and([
                filter("attempts", ">=", DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS),
                filter("last_error", "is not", null),
              ]),
            ),
          ">",
          0,
        ),
        eb(
          eb.fn
            .countAll<number>()
            .filterWhere((filter) =>
              filter.and([
                filter("status", "=", "claimed"),
                filter("claimed_at", "<=", staleClaimCutoff),
              ]),
            ),
          ">",
          0,
        ),
      ]),
    )
    .as("lanes");
  return executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom(laneTotals)
      .select((eb) => [
        "lanes.channel_id as channelId",
        "lanes.account_id as accountId",
        eb.fn.countAll<number>().as("laneCount"),
        eb.fn.sum<number>("lanes.pendingCount").as("pendingCount"),
        eb.fn.sum<number>("lanes.claimedCount").as("claimedCount"),
        eb(eb.fn.sum<number>("lanes.activeCount"), "-", eb.fn.countAll<number>()).as(
          "blockedCount",
        ),
        eb.fn.min<number>("lanes.oldestReceivedAt").as("oldestReceivedAt"),
      ])
      .groupBy(["lanes.channel_id", "lanes.account_id"])
      .orderBy("lanes.channel_id", "asc")
      .orderBy("lanes.account_id", "asc"),
  ).rows;
}

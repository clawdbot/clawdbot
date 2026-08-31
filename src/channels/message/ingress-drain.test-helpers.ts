import fs from "node:fs/promises";
import path from "node:path";
import type { Insertable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

export type IngressDrainTestPayload = { text: string };

export function createTestIngressQueue(
  stateDir: string,
  options: Omit<
    Parameters<typeof createChannelIngressQueue>[0],
    "channelId" | "accountId" | "stateDir"
  > = {},
) {
  return createChannelIngressQueue<IngressDrainTestPayload>({
    channelId: "test",
    accountId: "a",
    stateDir,
    ...options,
  });
}

export async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-ingress-drain-"),
  );
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

export function seedPendingBacklog(stateDir: string, total: number): void {
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const kysely = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">>(
    database.db,
  );
  for (let offset = 0; offset < total; offset += 500) {
    const rows: Array<Insertable<OpenClawStateKyselyDatabase["channel_ingress_events"]>> = [];
    const end = Math.min(offset + 500, total);
    for (let index = offset; index < end; index += 1) {
      rows.push({
        queue_name: JSON.stringify(["test", "a"]),
        event_id: `evt-${index}`,
        channel_id: "test",
        account_id: "a",
        status: "pending",
        lane_key: null,
        payload_json: JSON.stringify({ text: `msg-${index}` }),
        metadata_json: null,
        completed_metadata_json: null,
        received_at: index,
        updated_at: index,
        attempts: 0,
        claim_token: null,
        claim_owner: null,
        claimed_at: null,
        completed_at: null,
      });
    }
    executeSqliteQuerySync(database.db, kysely.insertInto("channel_ingress_events").values(rows));
  }
}

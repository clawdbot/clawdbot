/**
 * Read-only session reads reuse a handle this process already holds.
 * Opening a connection per call made sessions.list cost scale with row count,
 * because row projection and sharing resolution each read per row.
 */
import { expect, test, vi } from "vitest";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

const LIST_PARAMS = {
  agentId: "main",
  configuredAgentsOnly: true,
  includeDerivedTitles: true,
  includeGlobal: true,
  includeUnknown: true,
  limit: 100,
};

async function countConnectionOpensForRows(rows: number): Promise<number> {
  await createSessionStoreDir();
  const entries: Record<string, ReturnType<typeof sessionStoreEntry>> = {
    main: sessionStoreEntry("sess-main"),
  };
  for (let index = 0; index < rows; index++) {
    entries[`agent:main:row-${index}`] = sessionStoreEntry(`sess-row-${index}`, {
      updatedAt: 1_781_000_000_000 - index * 1_000,
    });
  }
  await writeSessionStore({ entries });
  // Warm lazily-initialized module state so only steady-state reads are counted.
  await directSessionReq("sessions.list", LIST_PARAMS);

  const spy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
  try {
    const result = await directSessionReq("sessions.list", LIST_PARAMS);
    expect(result.ok).toBe(true);
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

test("sessions.list connection opens do not scale with row count", async () => {
  const small = await countConnectionOpensForRows(5);
  const large = await countConnectionOpensForRows(40);

  // A connection per read would put `large` roughly 35 opens above `small`.
  expect(large).toBeLessThanOrEqual(small + 2);
});

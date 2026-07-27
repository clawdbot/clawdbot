/**
 * Sharing resolution runs per row, and each call materialized a whole session
 * lookup store. That made `sessions.list` quadratic in entries even after
 * connection reuse removed the per-row SQLite opens.
 */
import { expect, test, vi } from "vitest";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

const LIST_PARAMS = {
  agentId: "main",
  configuredAgentsOnly: true,
  includeDerivedTitles: true,
  includeGlobal: true,
  includeUnknown: true,
  limit: 100,
};

async function countMaterializedEntriesForRows(rows: number): Promise<number> {
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

  let materialized = 0;
  // Only the lookup-store path used by sharing resolution goes through
  // `listSessionEntries`; the listing itself and ACP metadata use the read-only
  // variant, so this isolates the per-row store loads under test.
  const original = sessionAccessor.listSessionEntries;
  const spies = [
    vi.spyOn(sessionAccessor, "listSessionEntries").mockImplementation(((...args: never[]) => {
      const result = (original as (...inner: never[]) => unknown[])(...args);
      materialized += Array.isArray(result) ? result.length : 0;
      return result;
    }) as never),
  ];
  try {
    const result = await directSessionReq("sessions.list", LIST_PARAMS);
    expect(result.ok).toBe(true);
    return materialized;
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

test("sessions.list does not materialize the lookup store once per row", async () => {
  const small = await countMaterializedEntriesForRows(5);
  const large = await countMaterializedEntriesForRows(40);

  // A load per row makes this quadratic: 40 rows would materialize roughly 64x
  // the entries of 5 rows. One cached load per request stays far below that.
  expect(large).toBeLessThan(small * 12);
});

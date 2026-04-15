import { describe, expect, it } from "vitest";
import { shouldSyncSessionsForReindex } from "./manager-session-reindex.js";

describe("memory manager session reindex gating", () => {
  it("keeps session syncing enabled for full reindexes triggered from session-start/watch", () => {
    expect(
      shouldSyncSessionsForReindex({
        hasSessionSource: true,
        sessionsDirty: false,
        dirtySessionFileCount: 0,
        sync: { reason: "session-start" },
        needsFullReindex: true,
      }),
    ).toBe(true);
    expect(
      shouldSyncSessionsForReindex({
        hasSessionSource: true,
        sessionsDirty: false,
        dirtySessionFileCount: 0,
        sync: { reason: "watch" },
        needsFullReindex: true,
      }),
    ).toBe(true);
    expect(
      shouldSyncSessionsForReindex({
        hasSessionSource: true,
        sessionsDirty: false,
        dirtySessionFileCount: 0,
        sync: { reason: "session-start" },
        needsFullReindex: false,
      }),
    ).toBe(false);
    expect(
      shouldSyncSessionsForReindex({
        hasSessionSource: true,
        sessionsDirty: false,
        dirtySessionFileCount: 0,
        sync: { reason: "watch" },
        needsFullReindex: false,
      }),
    ).toBe(false);
  });
});

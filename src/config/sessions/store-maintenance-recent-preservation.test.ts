// Recent-session preservation tests cover the operator-configured retention shield.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import {
  capEntryCount,
  pruneStaleEntries,
  resolveMaintenanceConfigFromInput,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("recent session maintenance preservation", () => {
  it("is opt-in and keeps recent interactive sessions through prune and cap pressure", () => {
    const now = Date.now();
    const recentKey = "agent:main:dashboard:recent";
    const staleKey = "agent:main:dashboard:stale";
    const syntheticKey = "agent:main:subagent:recent-worker";
    const store: Record<string, SessionEntry> = {
      [recentKey]: { sessionId: "recent", updatedAt: now - DAY_MS },
      [staleKey]: { sessionId: "stale", updatedAt: now - 8 * DAY_MS },
      [syntheticKey]: { sessionId: "synthetic", updatedAt: now - DAY_MS },
    };
    const preserveRecentMs = 7 * DAY_MS;

    expect(resolveMaintenanceConfigFromInput().preserveRecentMs).toBeNull();
    expect(
      resolveMaintenanceConfigFromInput({ preserveRecent: false }).preserveRecentMs,
    ).toBeNull();
    expect(resolveMaintenanceConfigFromInput({ preserveRecent: "7d" }).preserveRecentMs).toBe(
      preserveRecentMs,
    );

    expect(
      pruneStaleEntries(store, 12 * 60 * 60 * 1000, {
        preserveRecentMs,
      }),
    ).toBe(2);
    expect(store).toHaveProperty(recentKey);
    expect(store).not.toHaveProperty(staleKey);
    expect(store).not.toHaveProperty(syntheticKey);

    store[staleKey] = { sessionId: "stale-2", updatedAt: now - 8 * DAY_MS };
    expect(capEntryCount(store, 1, { preserveRecentMs })).toBe(1);
    expect(store).toHaveProperty(recentKey);
    expect(store).not.toHaveProperty(staleKey);
  });

  it("keeps recent interactive sessions under file-store disk pressure", async () => {
    await withTestDir({ prefix: "openclaw-preserve-recent-budget-" }, async (dir) => {
      const now = Date.now();
      const recentKey = "agent:main:dashboard:recent";
      const staleKey = "agent:main:dashboard:stale";
      const store: Record<string, SessionEntry> = {
        [recentKey]: {
          sessionId: "recent",
          updatedAt: now,
          displayName: "r".repeat(4_000),
        },
        [staleKey]: {
          sessionId: "stale",
          updatedAt: now - 8 * DAY_MS,
          displayName: "s".repeat(4_000),
        },
      };

      const result = await enforceSessionDiskBudget({
        store,
        storePath: path.join(dir, "sessions.json"),
        maintenance: {
          highWaterBytes: 1,
          maxDiskBytes: 1,
          preserveRecentMs: 7 * DAY_MS,
        },
        warnOnly: false,
      });

      expect(result?.removedEntries).toBe(1);
      expect(store).toHaveProperty(recentKey);
      expect(store).not.toHaveProperty(staleKey);
    });
  });
});

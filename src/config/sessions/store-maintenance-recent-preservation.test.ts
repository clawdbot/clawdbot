// Recent-session preservation tests cover the operator-configured retention shield.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import {
  capEntryCount,
  pruneStaleEntries,
  resolveMaintenanceConfigFromInput,
  shouldPreserveMaintenanceEntry,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function installThrowingConversationResolver() {
  const resolveSessionConversation = vi.fn(() => {
    throw new Error("channel resolver must not run during session maintenance");
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "broken",
        source: "test",
        plugin: {
          id: "broken",
          meta: { label: "Broken" },
          messaging: { resolveSessionConversation },
        },
      },
    ]),
  );
  return resolveSessionConversation;
}

describe("recent session maintenance preservation", () => {
  it.each(["classification", "pruning", "capping"] as const)(
    "preserves external conversations during %s without invoking channel plugins",
    (boundary) => {
      const resolveSessionConversation = installThrowingConversationResolver();

      const updatedAt = Date.now() - 31 * DAY_MS;
      const protectedKeys = [
        "agent:main:broken:group:room:thread:reply",
        "agent:main:broken:channel:room:with:colon",
        "agent:main:telegram:direct:user:topic:77",
        "agent:main:telegram:dm:user:topic:77",
        "agent:main:opaque:thread:reply",
      ];
      const removableKeys = [
        "agent:main:old",
        "agent:main:subagent:worker:thread:reply",
        "agent:main:opaque:topic:unrelated",
      ];
      const store: Record<string, SessionEntry> = Object.fromEntries(
        [...protectedKeys, ...removableKeys].map((key) => [key, { sessionId: key, updatedAt }]),
      );

      try {
        if (boundary === "classification") {
          for (const key of protectedKeys) {
            expect(shouldPreserveMaintenanceEntry({ key, entry: store[key] })).toBe(true);
          }
          for (const key of removableKeys) {
            expect(shouldPreserveMaintenanceEntry({ key, entry: store[key] })).toBe(false);
          }
        } else if (boundary === "pruning") {
          expect(pruneStaleEntries(store, 30 * DAY_MS, { log: false })).toBe(removableKeys.length);
        } else {
          expect(capEntryCount(store, protectedKeys.length, { log: false })).toBe(
            removableKeys.length,
          );
        }

        for (const key of protectedKeys) {
          expect(store).toHaveProperty(key);
        }
        expect(resolveSessionConversation).not.toHaveBeenCalled();
      } finally {
        resetPluginRuntimeStateForTest();
      }
    },
  );

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
    expect(store[staleKey]?.archivedAt).toEqual(expect.any(Number));
  });

  it("keeps recent and external sessions under disk pressure without invoking plugins", async () => {
    const resolveSessionConversation = installThrowingConversationResolver();
    try {
      await withTestDir({ prefix: "openclaw-preserve-recent-budget-" }, async (dir) => {
        const now = Date.now();
        const recentKey = "agent:main:dashboard:recent";
        const staleKey = "agent:main:dashboard:stale";
        const externalKey = "agent:main:broken:group:room:thread:reply";
        const store: Record<string, SessionEntry> = {
          [recentKey]: {
            sessionId: "recent",
            updatedAt: now,
            displayName: "r".repeat(4_000),
          },
          [staleKey]: {
            sessionId: "stale",
            updatedAt: now - 8 * DAY_MS,
            archivedAt: now - 8 * DAY_MS,
            archiveReason: "active-session-cap",
            displayName: "s".repeat(4_000),
          },
          [externalKey]: {
            sessionId: "external",
            updatedAt: now - 9 * DAY_MS,
            displayName: "e".repeat(4_000),
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
        expect(store).toHaveProperty(externalKey);
        expect(store).not.toHaveProperty(staleKey);
        expect(resolveSessionConversation).not.toHaveBeenCalled();
      });
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });
});

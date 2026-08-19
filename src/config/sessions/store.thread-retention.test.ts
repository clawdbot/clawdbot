import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import { pruneStaleThreadEntries, resolveMaintenanceConfigFromInput } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

describe("thread session retention", () => {
  it("prunes inactive threads across canonical, topic, and metadata shapes", () => {
    const now = Date.now();
    const staleAt = now - 31 * DAY_MS;
    const recentAt = now - DAY_MS;
    const store = makeStore([
      ["agent:main:slack:channel:C1:thread:1", makeEntry(staleAt)],
      ["agent:main:telegram:group:-100123:topic:77", makeEntry(staleAt)],
      [
        "agent:main:opaque-thread",
        {
          ...makeEntry(staleAt),
          delivery: normalizeSessionDeliveryState({
            context: { channel: "slack", to: "C1", threadId: "reply-1" },
            origin: { provider: "slack", threadId: "reply-1" },
          }),
        },
      ],
      ["agent:main:slack:channel:C2:thread:2", makeEntry(recentAt)],
      [
        "agent:main:slack:channel:C3:thread:3",
        { ...makeEntry(staleAt), lastInteractionAt: recentAt },
      ],
      ["agent:main:slack:channel:C4", makeEntry(staleAt)],
    ]);

    expect(pruneStaleThreadEntries(store, 30 * DAY_MS, { nowMs: now })).toBe(3);
    expect(store).not.toHaveProperty("agent:main:slack:channel:C1:thread:1");
    expect(store).not.toHaveProperty("agent:main:telegram:group:-100123:topic:77");
    expect(store).not.toHaveProperty("agent:main:opaque-thread");
    expect(store).toHaveProperty("agent:main:slack:channel:C2:thread:2");
    expect(store).toHaveProperty("agent:main:slack:channel:C3:thread:3");
    expect(store).toHaveProperty("agent:main:slack:channel:C4");
  });

  it("supports disabling thread retention", () => {
    const now = Date.now();
    const key = "agent:main:slack:channel:C1:thread:1";
    const store = makeStore([[key, makeEntry(now - 365 * DAY_MS)]]);

    expect(pruneStaleThreadEntries(store, null, { nowMs: now })).toBe(0);
    expect(store).toHaveProperty(key);
  });

  it("preserves active, user-retained, and unresolved thread work", () => {
    const now = Date.now();
    const staleAt = now - 31 * DAY_MS;
    const activeKey = "agent:main:slack:channel:C1:thread:active";
    const pinnedKey = "agent:main:slack:channel:C1:thread:pinned";
    const archivedKey = "agent:main:slack:channel:C1:thread:archived";
    const lockedKey = "agent:main:slack:channel:C1:thread:locked";
    const pendingKey = "agent:main:slack:channel:C1:thread:pending";
    const recentKey = "agent:main:slack:channel:C1:thread:recent-policy";
    const store = makeStore([
      [activeKey, makeEntry(staleAt)],
      [pinnedKey, { ...makeEntry(staleAt), pinnedAt: staleAt }],
      [archivedKey, { ...makeEntry(staleAt), archivedAt: staleAt }],
      [lockedKey, { ...makeEntry(staleAt), modelSelectionLocked: true }],
      [pendingKey, { ...makeEntry(staleAt), initializationPending: true }],
      [recentKey, makeEntry(now - 20 * DAY_MS)],
    ]);

    expect(
      pruneStaleThreadEntries(store, 10 * DAY_MS, {
        nowMs: now,
        preserveKeys: new Set([activeKey]),
        preserveRecentMs: 30 * DAY_MS,
      }),
    ).toBe(0);
    expect(Object.keys(store)).toHaveLength(6);
  });

  it("bounds inactive thread growth before capping while preserving active automation", async () => {
    const now = Date.now();
    const cronKey = "agent:main:cron:job:run:current";
    const heartbeatKey = "agent:main:heartbeat";
    const recentThreadKey = "agent:main:slack:channel:C1:thread:recent";
    const store = makeStore([
      [cronKey, makeEntry(now)],
      [heartbeatKey, makeEntry(now - 1)],
      [recentThreadKey, makeEntry(now - DAY_MS)],
      ...Array.from({ length: 40 }, (_, index): [string, SessionEntry] => [
        `agent:main:slack:channel:C1:thread:stale-${index}`,
        makeEntry(now - (31 + index) * DAY_MS),
      ]),
    ]);
    let report: { pruned: number; capped: number } | undefined;

    await applyFileBackedSessionStoreMaintenance({
      storePath: "/tmp/openclaw-sessions/thread-retention.json",
      store,
      activeSessionKey: cronKey,
      maintenanceConfig: {
        mode: "enforce",
        pruneAfterMs: 365 * DAY_MS,
        threadRetentionMs: 30 * DAY_MS,
        maxEntries: 4,
        modelRunPruneAfterMs: DAY_MS,
        resetArchiveRetentionMs: null,
        maxDiskBytes: null,
        highWaterBytes: null,
      },
      onMaintenanceApplied: (applied) => {
        report = { pruned: applied.pruned, capped: applied.capped };
      },
      log: { warn: () => {}, info: () => {} },
      artifacts: {
        archiveRemovedSessionTranscripts: async () => new Set<string>(),
        removeRemovedSessionTrajectoryArtifacts: async () => {},
        cleanupArchivedSessionTranscripts: async () => {},
      },
    });

    expect(report).toEqual({ pruned: 40, capped: 0 });
    expect(Object.keys(store)).toHaveLength(3);
    expect(store).toHaveProperty(cronKey);
    expect(store).toHaveProperty(heartbeatKey);
    expect(store).toHaveProperty(recentThreadKey);
  });

  it("defaults to 30d and allows custom or disabled retention", () => {
    expect(resolveMaintenanceConfigFromInput().threadRetentionMs).toBe(30 * DAY_MS);
    expect(resolveMaintenanceConfigFromInput({ threadRetention: "7d" }).threadRetentionMs).toBe(
      7 * DAY_MS,
    );
    expect(
      resolveMaintenanceConfigFromInput({ threadRetention: false }).threadRetentionMs,
    ).toBeNull();
  });
});

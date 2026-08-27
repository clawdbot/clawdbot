import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  hasFollowupQueueEntries,
  listFollowupQueueKeys,
  listUnreadableFollowupQueueKeys,
  loadFollowupQueueEntries,
  replaceFollowupQueueEntries,
} from "./followup-queue-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";

describe("followup-queue-sqlite", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = tempDirs.make("openclaw-followup-sqlite-");
    originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    closeOpenClawStateDatabaseForTest();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalEnv;
    }
  });

  it("lazily ensures followup_queue_entries on an existing schema database without bumping user_version", () => {
    openOpenClawStateDatabase({ env: process.env });
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    const { DatabaseSync } = requireNodeSqlite();
    const pre = new DatabaseSync(databasePath);
    try {
      pre.exec("DROP TABLE IF EXISTS followup_queue_entries;");
      expect(pre.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        pre
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'followup_queue_entries'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      pre.close();
    }

    closeOpenClawStateDatabaseForTest();
    // Existing v6 without the lazy table must still open cleanly.
    openOpenClawStateDatabase({ env: process.env });
    expect(hasFollowupQueueEntries(tmpDir)).toBe(false);

    replaceFollowupQueueEntries({
      stateDir: tmpDir,
      entries: [
        [
          "agent:main:dm:lazy",
          {
            items: [{ prompt: "lazy-ensure", enqueuedAt: 1, run: { agentId: "main" } }],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    const post = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(post.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        post
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'followup_queue_entries'",
          )
          .get(),
      ).toEqual({ name: "followup_queue_entries" });
    } finally {
      post.close();
    }
    expect(loadFollowupQueueEntries(tmpDir)[0]?.[0]).toBe("agent:main:dm:lazy");
  });

  it("round-trips queue entries through replace and load", () => {
    replaceFollowupQueueEntries({
      stateDir: tmpDir,
      entries: [
        [
          "agent:main:dm:sqlite-test",
          {
            items: [{ prompt: "stored", enqueuedAt: 1, run: { agentId: "main" } }],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });
    expect(hasFollowupQueueEntries(tmpDir)).toBe(true);
    const entries = loadFollowupQueueEntries(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe("agent:main:dm:sqlite-test");
    const queueData = entries[0]?.[1] as { items?: Array<{ prompt?: string }> };
    expect(queueData.items?.[0]?.prompt).toBe("stored");

    replaceFollowupQueueEntries({ stateDir: tmpDir, entries: [] });
    expect(hasFollowupQueueEntries(tmpDir)).toBe(false);
  });

  it("skips corrupt rows and still returns valid followup queue entries", () => {
    replaceFollowupQueueEntries({
      stateDir: tmpDir,
      entries: [["agent:main:dm:good", { items: [{ prompt: "stored", enqueuedAt: 1 }] }]],
    });
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(
        "INSERT INTO followup_queue_entries(queue_key, queue_json, updated_at) VALUES (?, ?, ?)",
      ).run("agent:main:dm:bad", "{not-json", Date.now());
    } finally {
      db.close();
    }

    const entries = loadFollowupQueueEntries(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe("agent:main:dm:good");
    expect(listFollowupQueueKeys(tmpDir)).toEqual(["agent:main:dm:bad", "agent:main:dm:good"]);
    expect(listUnreadableFollowupQueueKeys(tmpDir)).toEqual(["agent:main:dm:bad"]);
  });

  it("retains unreadable keys when replace is asked to keep them", () => {
    replaceFollowupQueueEntries({
      stateDir: tmpDir,
      entries: [["agent:main:dm:good", { items: [{ prompt: "stored", enqueuedAt: 1 }] }]],
    });
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(
        "INSERT INTO followup_queue_entries(queue_key, queue_json, updated_at) VALUES (?, ?, ?)",
      ).run("agent:main:dm:bad", "{not-json", Date.now());
    } finally {
      db.close();
    }

    replaceFollowupQueueEntries({
      stateDir: tmpDir,
      entries: [["agent:main:dm:imported", { items: [{ prompt: "imported", enqueuedAt: 2 }] }]],
      retainKeys: listFollowupQueueKeys(tmpDir),
    });

    expect(listFollowupQueueKeys(tmpDir)).toEqual([
      "agent:main:dm:bad",
      "agent:main:dm:good",
      "agent:main:dm:imported",
    ]);
    const entries = loadFollowupQueueEntries(tmpDir);
    expect(entries.map(([key]) => key)).toEqual(["agent:main:dm:good", "agent:main:dm:imported"]);
  });

  it("honors an explicit stateDir instead of the process-default state root", () => {
    const defaultDir = tempDirs.make("openclaw-followup-default-");
    const selectedDir = tempDirs.make("openclaw-followup-selected-");
    process.env.OPENCLAW_STATE_DIR = defaultDir;
    closeOpenClawStateDatabaseForTest();

    // Warm the process-default database so a wrong write path would hit it.
    openOpenClawStateDatabase({ env: process.env });
    expect(hasFollowupQueueEntries(defaultDir)).toBe(false);

    replaceFollowupQueueEntries({
      stateDir: selectedDir,
      entries: [
        [
          "agent:main:dm:selected-root",
          {
            items: [{ prompt: "selected-root-only", enqueuedAt: 1 }],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    expect(hasFollowupQueueEntries(selectedDir)).toBe(true);
    expect(hasFollowupQueueEntries(defaultDir)).toBe(false);
    expect(loadFollowupQueueEntries(selectedDir)[0]?.[0]).toBe("agent:main:dm:selected-root");
    expect(loadFollowupQueueEntries(defaultDir)).toHaveLength(0);

    replaceFollowupQueueEntries({ stateDir: selectedDir, entries: [] });
    expect(hasFollowupQueueEntries(selectedDir)).toBe(false);
    expect(hasFollowupQueueEntries(defaultDir)).toBe(false);

    closeOpenClawStateDatabaseForTest();
    process.env.OPENCLAW_STATE_DIR = tmpDir;
  });
});

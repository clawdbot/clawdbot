import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  followupQueueEntryContainsPrompt,
  listFollowupQueueKeys,
  loadFollowupQueueEntries,
  replaceFollowupQueueEntries,
} from "../../../infra/followup-queue-sqlite.js";
import * as followupQueueSqlite from "../../../infra/followup-queue-sqlite.js";
import { requireNodeSqlite } from "../../../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { enqueueFollowupRun } from "./enqueue.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKey,
  clearRestoredPendingDrainKeysForTest,
  hasPersistedFollowupQueues,
  peekRestoredPendingDrainKeys,
  persistFollowupQueues,
  persistFollowupQueuesOrThrow,
  restoreFollowupQueues,
  setRestoredFollowupQueuesListener,
} from "./persist.js";
import {
  FOLLOWUP_PERSIST_TEST_KEY as TEST_KEY,
  FOLLOWUP_PERSIST_TEST_SETTINGS as SETTINGS,
  createFollowupPersistTestItem as makeFollowupRun,
  createFollowupPersistTestRun as makeRun,
  readFollowupPersistQueueEntry as readPersistedQueueEntry,
} from "./persist.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "./recent-message-ids.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

describe("persistFollowupQueues / restoreFollowupQueues", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = tempDirs.make("openclaw-persist-test-");
    originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    FOLLOWUP_QUEUES.clear();
    resetRecentQueuedMessageIdDedupe();
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    FOLLOWUP_QUEUES.clear();
    clearFollowupQueuesRestoredFlagForTest();
    setRestoredFollowupQueuesListener(undefined);
    clearRuntimeConfigSnapshot();
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalEnv;
    }
  });

  it("writes shared SQLite state when a non-empty queue exists", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("hello"));
    persistFollowupQueues();
    expect(hasPersistedFollowupQueues()).toBe(true);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(true);
    const persisted = readPersistedQueueEntry(TEST_KEY) as { items?: unknown[] };
    expect(Array.isArray(persisted?.items)).toBe(true);
  });

  it("clears shared SQLite rows when all queues are empty", () => {
    replaceFollowupQueueEntries({
      entries: [[TEST_KEY, { items: [], mode: "steer", droppedCount: 0, summaryLines: [] }]],
    });
    expect(hasPersistedFollowupQueues()).toBe(true);
    persistFollowupQueues();
    expect(hasPersistedFollowupQueues()).toBe(false);
  });

  it("round-trips prompt and routing through persist+restore", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("queued message"));
    persistFollowupQueues();

    // Simulate a process restart: clear the in-memory map without re-persisting.
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored).toBeDefined();
    expect(restored!.items.length).toBe(1);
    expect(restored!.items[0]?.prompt).toBe("queued message");
    expect(restored!.items[0]?.originatingChannel).toBe("telegram");
    expect(restored!.items[0]?.originatingTo).toBe("12345");
    expect(restored!.draining).toBe(false);
  });

  it("round-trips reply-target and closed input provenance through persist+restore", () => {
    const run = makeRun();
    run.inputProvenance = {
      kind: "external_user",
      sourceChannel: "telegram",
      sourceSessionKey: "agent:main:dm:999",
      originSessionId: "sess-foreign",
    };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("thread reply"),
      originatingReplyToId: "telegram-msg-99",
      run,
    });
    persistFollowupQueues();

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0]?.originatingReplyToId).toBe("telegram-msg-99");
    expect(restored?.items[0]?.run.inputProvenance).toEqual({
      kind: "external_user",
      sourceChannel: "telegram",
    });
    expect(restored?.items[0]?.run.inputProvenance).not.toHaveProperty("sourceSessionKey");
    expect(restored?.items[0]?.run.inputProvenance).not.toHaveProperty("originSessionId");
  });

  it("round-trips media facts through persist+restore", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("with media"),
      media: [
        {
          path: "/tmp/photo.jpg",
          contentType: "image/jpeg",
          kind: "image",
          fileName: "photo.jpg",
        },
      ],
    });
    persistFollowupQueues();

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.media).toEqual([
      {
        path: "/tmp/photo.jpg",
        contentType: "image/jpeg",
        kind: "image",
        fileName: "photo.jpg",
      },
    ]);
  });

  it("round-trips summarySources and summaryElisions through persist+restore", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    const summarySource = makeFollowupRun("summarized overflow");
    queue.items.push(makeFollowupRun("still pending"));
    queue.droppedCount = 2;
    queue.summaryLines = ["summarized overflow", "elided sibling"];
    queue.summarySources = [summarySource];
    queue.summaryElisions = [
      {
        contextKey: "route-a",
        count: 1,
        sources: [makeFollowupRun("elided sibling")],
        summaryLines: ["elided sibling"],
        sourceRefs: new WeakMap(),
      },
    ];
    queue.evictedSummaryCount = 3;
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      summarySources?: Array<{ prompt?: string }>;
      summaryElisions?: Array<{
        contextKey?: string;
        count?: number;
        sources?: Array<{ prompt?: string }>;
        summaryLines?: string[];
        sourceRefs?: unknown;
      }>;
      evictedSummaryCount?: number;
    };
    expect(persisted.summarySources?.[0]?.prompt).toBe("summarized overflow");
    expect(persisted.summaryElisions?.[0]?.contextKey).toBe("route-a");
    expect(persisted.summaryElisions?.[0]?.sources?.[0]?.prompt).toBe("elided sibling");
    expect(persisted.summaryElisions?.[0]?.sourceRefs).toBeUndefined();
    expect(persisted.evictedSummaryCount).toBe(3);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.summarySources.map((item) => item.prompt)).toEqual(["summarized overflow"]);
    expect(restored?.summaryElisions).toHaveLength(1);
    expect(restored?.summaryElisions[0]?.contextKey).toBe("route-a");
    expect(restored?.summaryElisions[0]?.count).toBe(1);
    expect(restored?.summaryElisions[0]?.sources[0]?.prompt).toBe("elided sibling");
    expect(restored?.summaryElisions[0]?.summaryLines).toEqual(["elided sibling"]);
    expect(restored?.summaryElisions[0]?.sourceRefs).toBeInstanceOf(WeakMap);
    expect(restored?.evictedSummaryCount).toBe(3);
    expect(restored?.activeSummarySources).toBeInstanceOf(WeakSet);
  });

  it("persistFollowupQueuesOrThrow rethrows write failures", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("must settle"));
    const blocker = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blocker, "file");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    // Parent path is a file, so opening shared SQLite under it must fail.
    process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
    try {
      expect(() => persistFollowupQueuesOrThrow()).toThrow();
    } finally {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("rejects enqueue and rolls back when persistence fails", () => {
    const blocker = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blocker, "file");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
    try {
      const admitted = enqueueFollowupRun(
        TEST_KEY,
        makeFollowupRun("must not admit"),
        SETTINGS,
        "none",
      );
      expect(admitted).toBe(false);
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items ?? []).toEqual([]);
    } finally {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    expect(hasPersistedFollowupQueues()).toBe(false);
  });

  it("releases the message-id reservation when durable admission fails", () => {
    const blocker = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blocker, "file");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
    try {
      const admitted = enqueueFollowupRun(
        TEST_KEY,
        { ...makeFollowupRun("retry-after-persist-fail"), messageId: "tg-82572-retry" },
        SETTINGS,
      );
      expect(admitted).toBe(false);
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items ?? []).toEqual([]);
    } finally {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }

    const retried = enqueueFollowupRun(
      TEST_KEY,
      { ...makeFollowupRun("retry-after-persist-fail"), messageId: "tg-82572-retry" },
      SETTINGS,
    );
    expect(retried).toBe(true);
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.messageId)).toEqual([
      "tg-82572-retry",
    ]);
  });

  it("restores prior overflow mutations when admission persistence fails", () => {
    const tight: QueueSettings = {
      mode: "steer",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "old",
    };
    const kept = makeFollowupRun("keep-existing");
    expect(enqueueFollowupRun(TEST_KEY, kept, tight, "none")).toBe(true);
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
      "keep-existing",
    ]);

    const blocker = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blocker, "file");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
    try {
      const admitted = enqueueFollowupRun(
        TEST_KEY,
        makeFollowupRun("overflow-admit"),
        tight,
        "none",
      );
      expect(admitted).toBe(false);
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
        "keep-existing",
      ]);
    } finally {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("defers summary-elision lifecycle completion until admission persistence succeeds", () => {
    const tight: QueueSettings = {
      mode: "steer",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const abandoned: string[] = [];
    const settled: string[] = [];
    const makeTracked = (prompt: string): FollowupRun => ({
      ...makeFollowupRun(prompt),
      turnAdoptionLifecycle: {
        onAdopted: async () => undefined,
        onAbandoned: () => {
          abandoned.push(prompt);
        },
        onSettled: () => {
          settled.push(prompt);
        },
      },
    });

    // With cap=1 summarize:
    // 1st/2nd leave one line in summaryLines; 3rd elides the oldest source into
    // summaryElisions; a 4th would exceed the elision cap and complete the oldest.
    expect(enqueueFollowupRun(TEST_KEY, makeTracked("first"), tight, "none")).toBe(true);
    expect(enqueueFollowupRun(TEST_KEY, makeTracked("second"), tight, "none")).toBe(true);
    expect(enqueueFollowupRun(TEST_KEY, makeTracked("third"), tight, "none")).toBe(true);
    const beforeFail = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(beforeFail?.items.map((item) => item.prompt)).toEqual(["third"]);
    expect(
      beforeFail?.summaryElisions.reduce((count, entry) => count + entry.sources.length, 0),
    ).toBe(1);
    expect(beforeFail?.summaryElisions[0]?.sources[0]?.prompt).toBe("first");
    expect(abandoned).toEqual([]);
    expect(settled).toEqual([]);

    const blocker = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blocker, "file");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
    try {
      const admitted = enqueueFollowupRun(TEST_KEY, makeTracked("fourth"), tight, "none");
      expect(admitted).toBe(false);
    } finally {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["third"]);
    expect(
      restored?.summaryElisions.reduce((count, entry) => count + entry.sources.length, 0),
    ).toBe(1);
    expect(restored?.summaryElisions[0]?.sources[0]?.prompt).toBe("first");
    // Rejected admit settles itself; pre-existing summarized/"first" work must stay live.
    expect(abandoned).toEqual(["fourth"]);
    expect(settled).toEqual(["fourth"]);
  });

  it("keeps in-flight items in SQLite until settle-after-success", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    const item = makeFollowupRun("in flight");
    queue.items.push(item);
    queue.inFlight.add(item);
    persistFollowupQueues();

    expect(followupQueueEntryContainsPrompt(TEST_KEY, "in flight")).toBe(true);
  });

  it("omits current inbound prompt context from persist+restore", () => {
    const inboundContext = {
      text: "[OpenClaw room event]\nCurrent event:\n#42 Alice: ping",
      resumableText: "[OpenClaw room event]\nCurrent event:\n#42 Alice: ping",
    };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("[OpenClaw room event]"),
      transcriptPrompt: "",
      currentInboundEventKind: "room_event",
      currentInboundContext: inboundContext,
      originatingChatType: "group",
    });
    persistFollowupQueues();
    expect(JSON.stringify(readPersistedQueueEntry(TEST_KEY) ?? {})).not.toContain("Current event:");
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.currentInboundEventKind).toBe("room_event");
    expect(restored?.currentInboundContext).toBeUndefined();
    expect(restored?.originatingChatType).toBe("group");
  });

  it("omits quoted inbound context and keeps the audio flag through persist+restore", () => {
    const inboundContext = {
      text: "Quoted:\n> prior message\n\nreplying in thread",
      promptJoiner: "\n\n" as const,
    };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("replying in thread"),
      transcriptPrompt: "replying in thread",
      originatingReplyToId: "msg-quote-12",
      originatingChatType: "direct",
      currentInboundAudio: true,
      currentInboundContext: inboundContext,
    });
    persistFollowupQueues();
    expect(JSON.stringify(readPersistedQueueEntry(TEST_KEY) ?? {})).not.toContain("prior message");
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.originatingReplyToId).toBe("msg-quote-12");
    expect(restored?.currentInboundAudio).toBe(true);
    expect(restored?.currentInboundContext).toBeUndefined();
  });

  it("persists cap-driven elision trimming before a rejected enqueue survives restart", () => {
    const wide: QueueSettings = { mode: "steer", debounceMs: 0, cap: 3, dropPolicy: "summarize" };
    const tight: QueueSettings = { mode: "steer", debounceMs: 0, cap: 1, dropPolicy: "summarize" };
    const queue = getFollowupQueue(TEST_KEY, wide);
    queue.items.push({ ...makeFollowupRun("live-turn"), messageId: "live-1" });
    queue.droppedCount = 3;
    queue.summaryLines = ["oldest", "middle", "newest"];
    for (const prompt of ["oldest", "middle", "newest"] as const) {
      queue.summaryElisions.push({
        contextKey: prompt,
        count: 1,
        sources: [makeFollowupRun(prompt)],
        summaryLines: [prompt],
        sourceRefs: new WeakMap(),
      });
    }
    persistFollowupQueues();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "oldest")).toBe(true);

    expect(
      enqueueFollowupRun(TEST_KEY, { ...makeFollowupRun("live-turn"), messageId: "live-1" }, tight),
    ).toBe(false);

    expect(
      FOLLOWUP_QUEUES.get(TEST_KEY)?.summaryElisions.flatMap((entry) =>
        entry.sources.map((source) => source.prompt),
      ),
    ).toEqual(["newest"]);
    const persistedAfterReject = readPersistedQueueEntry(TEST_KEY) as {
      summaryElisions?: Array<{ sources: Array<{ prompt: string }> }>;
    };
    expect(
      persistedAfterReject.summaryElisions?.flatMap((entry) =>
        entry.sources.map((source) => source.prompt),
      ),
    ).toEqual(["newest"]);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    expect(
      FOLLOWUP_QUEUES.get(TEST_KEY)?.summaryElisions.flatMap((entry) =>
        entry.sources.map((source) => source.prompt),
      ),
    ).toEqual(["newest"]);
  });

  it("round-trips chat delivery identity and execution context through persist+restore", () => {
    const run = makeRun();
    run.chatType = "direct";
    run.clientCaps = ["images", "voice"];
    run.channelContext = { chat: { id: "12345", extra: "open-ended-identity" } };
    run.spawnedBy = "agent:main:telegram:direct:seed";
    run.approvalReviewerDeviceId = "device-7";
    run.taskSuggestionDeliveryMode = "gateway";
    run.modelSelectionLocked = true;
    run.fastMode = true;
    run.fastModeAutoOnSeconds = 15;
    run.fastModeOverride = true;
    run.fastModeAutoOnSecondsOverride = true;
    run.runTimeoutOverrideMs = 45_000;
    run.cliSessionBindingFacts = {
      extraSystemPromptStatic: "nested-static-do-not-leak",
      sourceReplyDeliveryMode: "message_tool_only",
      requireExplicitMessageTarget: true,
    };
    run.toolBindings = { search: { enabled: true } };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("full route context"),
      originatingChatId: "telegram-chat-1",
      originatingReplyToMode: "first",
      run,
    });

    persistFollowupQueues();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "nested-static-do-not-leak")).toBe(false);
    expect(JSON.stringify(readPersistedQueueEntry(TEST_KEY) ?? {})).not.toContain(
      "nested-static-do-not-leak",
    );
    expect(JSON.stringify(readPersistedQueueEntry(TEST_KEY) ?? {})).not.toContain(
      "open-ended-identity",
    );
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.originatingChatId).toBe("telegram-chat-1");
    expect(restored?.originatingReplyToMode).toBe("first");
    expect(restored?.run.chatType).toBe("direct");
    expect(restored?.run.clientCaps).toBeUndefined();
    expect(restored?.run.channelContext).toBeUndefined();
    expect(restored?.run.spawnedBy).toBe("agent:main:telegram:direct:seed");
    expect(restored?.run.approvalReviewerDeviceId).toBeUndefined();
    expect(restored?.run.taskSuggestionDeliveryMode).toBe("gateway");
    expect(restored?.run.modelSelectionLocked).toBe(true);
    expect(restored?.run.fastMode).toBe(true);
    expect(restored?.run.fastModeAutoOnSeconds).toBe(15);
    expect(restored?.run.fastModeOverride).toBe(true);
    expect(restored?.run.fastModeAutoOnSecondsOverride).toBe(true);
    expect(restored?.run.runTimeoutOverrideMs).toBe(45_000);
    expect(restored?.run.cliSessionBindingFacts).toEqual({
      sourceReplyDeliveryMode: "message_tool_only",
      requireExplicitMessageTarget: true,
    });
    expect(restored?.run.toolBindings).toBeUndefined();
  });

  it("strips nested extraSystemPromptStatic from legacy cliSessionBindingFacts on restore", () => {
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "legacy-cli-binding",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...makeRun(),
                  cliSessionBindingFacts: {
                    extraSystemPromptStatic: "LEGACY-CLI-PROMPT-SENTINEL",
                    sourceReplyDeliveryMode: "message_tool_only",
                    requireExplicitMessageTarget: true,
                  },
                },
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 1,
            debounceMs: 500,
            cap: 20,
            dropPolicy: "summarize",
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "LEGACY-CLI-PROMPT-SENTINEL")).toBe(true);

    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.run.cliSessionBindingFacts).toEqual({
      sourceReplyDeliveryMode: "message_tool_only",
      requireExplicitMessageTarget: true,
    });
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.run.extraSystemPromptStatic).toBeUndefined();
  });

  it("skips malformed persisted queue rows during restore", () => {
    replaceFollowupQueueEntries({
      entries: [[TEST_KEY, { items: [{ prompt: 7, run: {} }], mode: "steer" }]],
    });

    expect(() => restoreFollowupQueues()).not.toThrow();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
  });

  it("round-trips bare session-reset transcript without current-turn context", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      prompt: "sender_id=telegram-user-1\nStartup context",
      transcriptPrompt: "[OpenClaw session reset]",
      enqueuedAt: Date.now(),
      run: makeRun(),
      originatingChannel: "telegram",
      originatingTo: "user-1",
    });
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.transcriptPrompt).toBe("[OpenClaw session reset]");
    expect(restored?.currentInboundContext).toBeUndefined();
    expect(restored?.currentInboundEventKind).toBeUndefined();
    expect(restored?.currentInboundAudio).toBeUndefined();
  });

  it("does not restore abortSignal (runtime-only field stripped on persist)", () => {
    const controller = new AbortController();
    const run = { ...makeFollowupRun("signal test"), abortSignal: controller.signal };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(run);
    persistFollowupQueues();

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0]?.abortSignal).toBeUndefined();
  });

  it("is a no-op when no persisted queue rows exist", () => {
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(() => restoreFollowupQueues()).not.toThrow();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
  });

  it("guards restore against split-module re-evaluation (restore-once)", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("originally queued"));
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();

    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.prompt).toBe("originally queued");

    FOLLOWUP_QUEUES.set(TEST_KEY, {
      abortController: new AbortController(),
      items: [makeFollowupRun("arrived during drain")],
      draining: true,
      inFlight: new Set(),
      lastEnqueuedAt: Date.now(),
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
      droppedCount: 0,
      summaryLines: [],
      summarySources: [],
      steerAcceptanceTail: Promise.resolve(true),
      activeSummarySources: new WeakSet(),
      summaryElisions: [],
      evictedSummaryCount: 0,
    });

    restoreFollowupQueues();
    const afterSecondRestore = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(afterSecondRestore?.items[0]?.prompt).toBe("arrived during drain");
    expect(afterSecondRestore?.draining).toBe(true);
  });

  it("retries restore after a transient SQLite initialization failure", () => {
    const loadSpy = vi.spyOn(followupQueueSqlite, "loadFollowupQueueEntries");
    try {
      const queue = getFollowupQueue(TEST_KEY, SETTINGS);
      queue.items.push(makeFollowupRun("retry-after-busy"));
      persistFollowupQueues();
      FOLLOWUP_QUEUES.delete(TEST_KEY);
      clearFollowupQueuesRestoredFlagForTest();

      loadSpy.mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });
      restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();

      restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.prompt).toBe("retry-after-busy");
    } finally {
      loadSpy.mockRestore();
      clearFollowupQueuesRestoredFlagForTest();
    }
  });

  it("notifies the restored-queue listener after a successful restore retry", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const loadSpy = vi.spyOn(followupQueueSqlite, "loadFollowupQueueEntries");
    try {
      const queue = getFollowupQueue(TEST_KEY, SETTINGS);
      queue.items.push(makeFollowupRun("retry-then-wake"));
      persistFollowupQueues();
      FOLLOWUP_QUEUES.delete(TEST_KEY);
      clearFollowupQueuesRestoredFlagForTest();
      setRestoredFollowupQueuesListener(listener);

      loadSpy.mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });
      restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
      expect(listener).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.prompt).toBe("retry-then-wake");
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      loadSpy.mockRestore();
      vi.useRealTimers();
      clearFollowupQueuesRestoredFlagForTest();
    }
  });

  it("retains unreadable SQLite rows across ordinary persist mutations", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("live-queue"));
    persistFollowupQueues();

    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath();
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(
        "INSERT INTO followup_queue_entries(queue_key, queue_json, updated_at) VALUES (?, ?, ?)",
      ).run("agent:main:dm:corrupt-sqlite", "{not-json", Date.now());
    } finally {
      db.close();
    }

    persistFollowupQueuesOrThrow();

    expect(listFollowupQueueKeys()).toEqual(
      expect.arrayContaining(["agent:main:dm:corrupt-sqlite", TEST_KEY]),
    );
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "live-queue")).toBe(true);
    expect(loadFollowupQueueEntries().map(([key]) => key)).toEqual([TEST_KEY]);
  });

  it("resumes restore after the flag is explicitly cleared (test hook)", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("first round"));
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.prompt).toBe("first round");

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();

    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.prompt).toBe("first round");
  });

  it("registers restored keys in the pending-drain set when queue has items", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("pending delivery"));
    persistFollowupQueues();

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();

    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(true);
    clearRestoredPendingDrainKey(TEST_KEY);
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
  });

  it("does not add to pending-drain set when restored queue is empty", () => {
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          { items: [], mode: "steer", droppedCount: 0, summaryLines: [], lastEnqueuedAt: 1 },
        ],
      ],
    });
    restoreFollowupQueues();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
  });

  it("registers summary-only restored queues in the pending-drain set", () => {
    const summarySource = makeFollowupRun("summarized-only");
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [],
            mode: "steer",
            droppedCount: 1,
            summaryLines: ["summarized-only"],
            summarySources: [
              {
                prompt: summarySource.prompt,
                enqueuedAt: summarySource.enqueuedAt,
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  agentId: "main",
                  sessionId: "sess-persist",
                  sessionKey: TEST_KEY,
                  sessionFile: "/tmp/sess.jsonl",
                  workspaceDir: "/tmp/ws",
                  provider: "anthropic",
                  model: "claude",
                  timeoutMs: 30000,
                  blockReplyBreak: "message_end",
                },
              },
            ],
            lastEnqueuedAt: 1,
          },
        ],
      ],
    });
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.summarySources.map((item) => item.prompt)).toEqual([
      "summarized-only",
    ]);
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(true);
  });

  it("persists queue data in shared SQLite state", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("private"));
    persistFollowupQueues();

    expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(true);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "private")).toBe(true);
  });

  it("strips secret-bearing runtime fields but persists auth and reply context selectors", () => {
    const run = makeRun();
    run.config = {
      defaults: { agent: { provider: "anthropic-secret", model: "claude-secret" } },
    } as FollowupRun["run"]["config"];
    run.skillsSnapshot = {
      sensitive: "details",
    } as unknown as FollowupRun["run"]["skillsSnapshot"];
    run.extraSystemPrompt = "do-not-leak";
    run.extraSystemPromptStatic = "static-do-not-leak";
    run.authProfileId = "profile-secret";
    run.authProfileIdSource = "user";
    run.inputProvenance = {
      kind: "external_user",
      sourceChannel: "telegram",
      sourceSessionKey: "agent:main:dm:123",
    };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("descriptor"),
      originatingReplyToId: "msg-42",
      run,
    });
    queue.lastRun = run;
    persistFollowupQueues();

    const entries = loadFollowupQueueEntries();
    const raw = JSON.stringify(entries);
    for (const needle of [
      "anthropic-secret",
      "claude-secret",
      "sensitive",
      "do-not-leak",
      "static-do-not-leak",
    ]) {
      expect(raw).not.toContain(needle);
    }
    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ originatingReplyToId?: string; run: Record<string, unknown> }>;
      lastRun?: Record<string, unknown>;
    };
    const persistedItem = persisted.items[0]!;
    const persistedRun = persistedItem.run;
    expect(persistedItem.originatingReplyToId).toBe("msg-42");
    expect(persistedRun.config).toBeUndefined();
    expect(persistedRun.skillsSnapshot).toBeUndefined();
    expect(persistedRun.extraSystemPrompt).toBeUndefined();
    expect(persistedRun.extraSystemPromptStatic).toBeUndefined();
    expect(persistedRun.authProfileId).toBe("profile-secret");
    expect(persistedRun.authProfileIdSource).toBe("user");
    expect(persistedRun.inputProvenance).toEqual({
      kind: "external_user",
      sourceChannel: "telegram",
    });
    expect(persistedRun.inputProvenance).not.toHaveProperty("sourceSessionKey");
    expect(persistedRun.inputProvenance).not.toHaveProperty("originSessionId");
    const persistedLastRun = persisted.lastRun;
    expect(persistedLastRun?.config).toBeUndefined();
    expect(persistedLastRun?.skillsSnapshot).toBeUndefined();
    expect(persistedLastRun?.authProfileId).toBe("profile-secret");
    expect(persistedLastRun?.authProfileIdSource).toBe("user");
    expect(persistedLastRun?.inputProvenance).toEqual({
      kind: "external_user",
      sourceChannel: "telegram",
    });
    expect(persistedLastRun?.inputProvenance).not.toHaveProperty("sourceSessionKey");
  });

  it("round-trips auth profile selection through restore", () => {
    const run = makeRun();
    run.authProfileId = "anthropic:work";
    run.authProfileIdSource = "user";
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({ ...makeFollowupRun("auth-bound"), run });
    queue.lastRun = run;
    persistFollowupQueues();

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0]?.run.authProfileId).toBe("anthropic:work");
    expect(restored?.items[0]?.run.authProfileIdSource).toBe("user");
    expect(restored?.lastRun?.authProfileId).toBe("anthropic:work");
    expect(restored?.lastRun?.authProfileIdSource).toBe("user");
  });

  it("round-trips session tool overrides and prepared model-routing facts", () => {
    const run = makeRun();
    run.toolOverrides = {
      webSearch: false,
      mcpServers: { browser: false },
      mcpToolsDeny: { github: ["create_issue"] },
      skills: { web_search: false },
    };
    run.conversationToolPolicy = { deny: ["user-mail__inbox", "browser"] };
    run.requestedRouteResolution = "resolved";
    run.thinkingCatalog = [
      { provider: "openai", id: "gpt-5.6-luna", reasoning: true },
      { provider: "anthropic", id: "claude", reasoning: false },
    ];
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("policy-bound"),
      run,
      disableCollectBatching: true,
      strandedReplyRetry: true,
    });
    queue.lastRun = run;
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{
        run: Record<string, unknown>;
        disableCollectBatching?: boolean;
        strandedReplyRetry?: boolean;
      }>;
      lastRun?: Record<string, unknown>;
    };
    expect(persisted.items[0]?.run.toolOverrides).toEqual(run.toolOverrides);
    expect(persisted.items[0]?.run.conversationToolPolicy).toEqual(run.conversationToolPolicy);
    expect(persisted.items[0]?.run.requestedRouteResolution).toBe("resolved");
    expect(persisted.items[0]?.run.thinkingCatalog).toEqual(run.thinkingCatalog);
    expect(persisted.items[0]?.disableCollectBatching).toBe(true);
    expect(persisted.items[0]?.strandedReplyRetry).toBe(true);
    expect(persisted.lastRun?.toolOverrides).toEqual(run.toolOverrides);
    expect(persisted.lastRun?.conversationToolPolicy).toEqual(run.conversationToolPolicy);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0]?.run.toolOverrides).toEqual(run.toolOverrides);
    expect(restored?.items[0]?.run.conversationToolPolicy).toEqual(run.conversationToolPolicy);
    expect(restored?.items[0]?.run.requestedRouteResolution).toBe("resolved");
    expect(restored?.items[0]?.run.thinkingCatalog).toEqual(run.thinkingCatalog);
    expect(restored?.items[0]?.disableCollectBatching).toBe(true);
    expect(restored?.items[0]?.strandedReplyRetry).toBe(true);
    expect(restored?.lastRun?.toolOverrides).toEqual(run.toolOverrides);
    expect(restored?.lastRun?.conversationToolPolicy).toEqual(run.conversationToolPolicy);
    expect(restored?.lastRun?.requestedRouteResolution).toBe("resolved");
    expect(restored?.lastRun?.thinkingCatalog).toEqual(run.thinkingCatalog);
  });
});

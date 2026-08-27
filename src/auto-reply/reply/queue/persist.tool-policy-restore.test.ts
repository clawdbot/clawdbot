import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  followupQueueEntryContainsPrompt,
  replaceFollowupQueueEntries,
} from "../../../infra/followup-queue-sqlite.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  restoreFollowupQueues,
  setRestoredFollowupQueuesListener,
} from "./persist.js";
import {
  FOLLOWUP_PERSIST_TEST_KEY as TEST_KEY,
  createFollowupPersistTestRun as makeRun,
} from "./persist.test-helpers.js";
import { FOLLOWUP_QUEUES } from "./state.js";

describe("persistFollowupQueues tool-policy restore", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-persist-tool-policy-");
    FOLLOWUP_QUEUES.clear();
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

  it("fail-closes restored items whose intersection lacks toolsAllow", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "intersection-only-secret",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                messageId: "tg-intersection-only",
                toolsAllowIntersection: [["exec"]],
                run: validRun,
              },
              {
                prompt: "ordinary-turn",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: validRun,
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      restoreFollowupQueues();
      const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
      expect(restored?.items.map((item) => item.prompt)).toEqual(["ordinary-turn"]);
      expect(restored?.items.every((item) => item.toolsAllow === undefined)).toBe(true);
      expect(followupQueueEntryContainsPrompt(TEST_KEY, "intersection-only-secret")).toBe(false);
      expect(followupQueueEntryContainsPrompt(TEST_KEY, "ordinary-turn")).toBe(true);
      const logged = errorSpy.mock.calls
        .map((call) => (typeof call[0] === "string" ? call[0] : ""))
        .join("\n");
      expect(logged).toContain(TEST_KEY);
      expect(logged).toContain("messageId=tg-intersection-only");
      expect(logged).not.toContain("intersection-only-secret");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fail-closes overflow summary sources whose intersection lacks toolsAllow", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "kept-item",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: validRun,
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 1,
            summaryLines: ["intersection-only-overflow-secret"],
            summarySources: [
              {
                prompt: "intersection-only-overflow-secret",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                toolsAllowIntersection: [["exec"]],
                run: validRun,
              },
            ],
          },
        ],
      ],
    });

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["kept-item"]);
    expect(restored?.summarySources ?? []).toEqual([]);
    expect(restored?.summaryLines ?? []).toEqual([]);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "intersection-only-overflow-secret")).toBe(
      false,
    );
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "kept-item")).toBe(true);
  });

  it("fail-closes overflow elision sources whose intersection lacks toolsAllow", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "live-item",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: validRun,
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 1,
            summaryLines: [],
            summaryElisions: [
              {
                contextKey: "route-a",
                count: 1,
                sources: [
                  {
                    prompt: "intersection-only-elision-secret",
                    enqueuedAt: Date.now(),
                    originatingChannel: "telegram",
                    originatingTo: "12345",
                    toolsAllowIntersection: [["exec"]],
                    run: validRun,
                  },
                ],
                summaryLines: ["intersection-only-elision-secret"],
              },
            ],
          },
        ],
      ],
    });

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["live-item"]);
    expect(restored?.summaryElisions ?? []).toEqual([]);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "intersection-only-elision-secret")).toBe(
      false,
    );
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "live-item")).toBe(true);
  });
});

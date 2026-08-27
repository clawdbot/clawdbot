// Tests queue state storage, dedupe, and cleanup primitives.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { enqueueFollowupRun } from "./enqueue.js";
import { persistFollowupQueues } from "./persist.js";
import {
  clearFollowupQueue,
  FOLLOWUP_QUEUES,
  getFollowupQueue,
  hasPendingFollowupQueueWork,
  refreshQueuedFollowupSession,
} from "./state.js";
import type { FollowupRun } from "./types.js";

const QUEUE_KEY = "agent:main:dm:test";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  try {
    clearFollowupQueue(QUEUE_KEY);
  } catch {
    FOLLOWUP_QUEUES.delete(QUEUE_KEY);
  }
});

function makeRun(): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: "session-1",
    sessionKey: QUEUE_KEY,
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    config: {} as FollowupRun["run"]["config"],
    provider: "anthropic",
    model: "claude-opus-4-6",
    requestedRouteResolution: "resolved",
    authProfileId: "profile-a",
    authProfileIdSource: "user",
    timeoutMs: 30_000,
    blockReplyBreak: "message_end",
  };
}

describe("refreshQueuedFollowupSession", () => {
  it("retargets queued runs to the persisted selection", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const lastRun = makeRun();
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    const summarizedRun: FollowupRun = {
      prompt: "summarized message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    queue.lastRun = lastRun;
    queue.items.push(queuedRun);
    queue.summarySources.push(summarizedRun);
    queue.summaryElisions.push({
      contextKey: "context",
      count: 2,
      sources: [
        {
          prompt: "elided summary",
          enqueuedAt: Date.now(),
          run: makeRun(),
        },
      ],
      summaryLines: ["elided summary"],
      sourceRefs: new WeakMap(),
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "openai",
      nextModel: "gpt-4o",
      nextRouteResolution: "resolved",
      nextAuthProfileId: undefined,
      nextAuthProfileIdSource: undefined,
    });

    expect(queue.lastRun).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.items[0]?.run).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.summarySources[0]?.run).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.summaryElisions[0]?.sources[0]?.run).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("retargets queued runs with user model override source", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), hasAutoFallbackProvenance: true },
    };
    queue.items.push(queuedRun);

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "ollama",
      nextModel: "qwen3.5:27b",
      nextRouteResolution: "resolved",
      nextModelOverrideSource: "user",
    });

    expect(queue.items[0]?.run).toEqual({
      ...makeRun(),
      provider: "ollama",
      model: "qwen3.5:27b",
      hasSessionModelOverride: true,
      modelOverrideSource: "user",
    });
  });

  it("clears queued model override strictness when retargeting to the configured default", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: {
        ...makeRun(),
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
      },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "anthropic",
      nextModel: "claude-opus-4-6",
      nextRouteResolution: "resolved",
      nextModelOverrideSource: undefined,
    });

    expect(queue.items[0]?.run).toMatchObject({
      hasSessionModelOverride: false,
      modelOverrideSource: undefined,
    });
  });

  it("clamps queued Sol Ultra work to Codex Luna Max", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: {
        ...makeRun(),
        provider: "openai",
        model: "gpt-5.6-sol",
        thinkLevel: "ultra",
      },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "openai",
      nextModel: "gpt-5.6-luna",
      nextRouteResolution: "resolved",
      nextThinking: {
        level: "ultra",
        catalog: [{ provider: "openai", id: "gpt-5.6-luna", reasoning: true }],
        agentRuntime: "codex",
      },
    });

    expect(queue.items[0]?.run).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      thinkLevel: "max",
      thinkingCatalog: [{ provider: "openai", id: "gpt-5.6-luna", reasoning: true }],
    });
  });

  it("uses the highest supported non-max level when retargeting queued work", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), thinkLevel: "ultra" },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "custom",
      nextModel: "reasoner",
      nextRouteResolution: "resolved",
      nextThinking: { level: "ultra", agentRuntime: "openclaw" },
    });

    expect(queue.items[0]?.run.thinkLevel).toBe("high");
  });

  it("recomputes the retargeted model default when the session has no thinking override", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), thinkLevel: "ultra" },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "openai",
      nextModel: "gpt-5.6-sol",
      nextRouteResolution: "resolved",
      nextThinking: { agentRuntime: "codex" },
    });

    // Sol's provider default reasoning level is medium (extensions/openai
    // thinking-policy.ts); retargeting without an override adopts it.
    expect(queue.items[0]?.run.thinkLevel).toBe("medium");
  });
});

describe("getFollowupQueue", () => {
  it("aborts work owned by a cleared queue", () => {
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    enqueueFollowupRun(QUEUE_KEY, queuedRun, { mode: "followup" });

    expect(queuedRun.queueAbortSignal?.aborted).toBe(false);
    clearFollowupQueue(QUEUE_KEY);
    expect(queuedRun.queueAbortSignal?.aborted).toBe(true);
  });

  it("restores the queue when clear persistence fails", () => {
    const stateDir = tempDirs.make("openclaw-clear-persist-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const queuedRun: FollowupRun = {
        prompt: "must survive clear failure",
        enqueuedAt: Date.now(),
        run: makeRun(),
      };
      enqueueFollowupRun(QUEUE_KEY, queuedRun, { mode: "followup" });
      expect(queuedRun.queueAbortSignal?.aborted).toBe(false);
      const blocker = path.join(stateDir, "not-a-directory");
      fs.writeFileSync(blocker, "file");
      process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
      expect(() => clearFollowupQueue(QUEUE_KEY)).toThrow();
      const restored = FOLLOWUP_QUEUES.get(QUEUE_KEY);
      expect(restored?.items.map((item) => item.prompt)).toEqual(["must survive clear failure"]);
      expect(queuedRun.queueAbortSignal?.aborted).toBe(false);
      expect(restored?.items[0]?.queueAbortSignal?.aborted).toBe(false);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("restores run fields when refresh persistence fails", () => {
    const stateDir = tempDirs.make("openclaw-refresh-persist-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const queuedRun: FollowupRun = {
        prompt: "queued message",
        enqueuedAt: Date.now(),
        run: makeRun(),
      };
      queue.items.push(queuedRun);
      const blocker = path.join(stateDir, "not-a-directory");
      fs.writeFileSync(blocker, "file");
      process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
      expect(() =>
        refreshQueuedFollowupSession({
          key: QUEUE_KEY,
          nextProvider: "openai",
          nextModel: "gpt-4o",
          nextRouteResolution: "resolved",
        }),
      ).toThrow();
      expect(queue.items[0]?.run.provider).toBe("anthropic");
      expect(queue.items[0]?.run.model).toBe("claude-opus-4-6");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("trims overflow metadata when a live queue cap shrinks", () => {
    const stateDir = tempDirs.make("openclaw-cap-shrink-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 3 });
      for (const [contextKey, count] of [
        ["oldest", 2],
        ["middle", 3],
        ["newest", 4],
      ] as const) {
        queue.summaryElisions.push({
          contextKey,
          count,
          sources: Array.from({ length: count }, () => ({
            prompt: contextKey,
            enqueuedAt: Date.now(),
            run: makeRun(),
          })),
          summaryLines: Array.from({ length: count }, () => contextKey),
          sourceRefs: new WeakMap(),
        });
      }
      queue.droppedCount = 9;
      queue.evictedSummaryCount = 5;
      persistFollowupQueues();

      const updated = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 });

      expect(updated.summaryElisions.map((entry) => entry.contextKey)).toEqual(["newest"]);
      expect(updated.summaryElisions[0]?.sources).toHaveLength(1);
      expect(updated.summaryElisions[0]?.summaryLines).toEqual(["newest"]);
      expect(updated.evictedSummaryCount).toBe(13);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("rolls back cap-driven elision trimming when persistence fails", () => {
    const stateDir = tempDirs.make("openclaw-cap-trim-fail-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 3 });
      queue.summaryElisions.push({
        contextKey: "keep",
        count: 2,
        sources: Array.from({ length: 2 }, () => ({
          prompt: "keep",
          enqueuedAt: Date.now(),
          run: makeRun(),
        })),
        summaryLines: ["keep", "keep"],
        sourceRefs: new WeakMap(),
      });
      queue.droppedCount = 2;
      persistFollowupQueues();

      const blocker = path.join(stateDir, "not-a-directory");
      fs.writeFileSync(blocker, "file");
      process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
      expect(() => getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 })).toThrow();
      expect(queue.summaryElisions[0]?.sources).toHaveLength(2);
      expect(queue.evictedSummaryCount).toBe(0);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });
});

describe("hasPendingFollowupQueueWork", () => {
  it("detects each actionable queued-work representation", () => {
    const cases = [
      (queue: ReturnType<typeof getFollowupQueue>) => {
        queue.items.push({
          prompt: "queued message",
          enqueuedAt: Date.now(),
          run: makeRun(),
        });
      },
      (queue: ReturnType<typeof getFollowupQueue>) => {
        queue.inFlight.add({
          prompt: "in-flight collected message",
          enqueuedAt: Date.now(),
          run: makeRun(),
        });
      },
      (queue: ReturnType<typeof getFollowupQueue>) => {
        queue.droppedCount = 1;
      },
    ];

    for (const populate of cases) {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      populate(queue);
      expect(hasPendingFollowupQueueWork(["", ` ${QUEUE_KEY} `, QUEUE_KEY])).toBe(true);
      clearFollowupQueue(QUEUE_KEY);
    }
  });

  it("ignores empty queues and historical eviction accounting", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.evictedSummaryCount = 3;

    expect(hasPendingFollowupQueueWork([undefined, "", QUEUE_KEY])).toBe(false);
  });
});

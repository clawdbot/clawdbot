// Proves queue caps and depth describe pending work while active identities remain in shared state.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFollowupQueue,
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  scheduleFollowupDrain,
} from "./queue.js";
import { createDeferred, createQueueTestRun as createRun } from "./queue.test-helpers.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import type { FollowupRun, QueueDropPolicy, QueueSettings } from "./queue/types.js";

describe("followup queue in-flight ownership", () => {
  const keys = new Set<string>();

  afterEach(() => {
    for (const key of keys) {
      clearFollowupQueue(key);
    }
    keys.clear();
  });

  const createKey = (suffix: string) => {
    const key = `test-in-flight-${suffix}-${Date.now()}-${Math.random()}`;
    keys.add(key);
    return key;
  };

  const createSettings = (dropPolicy: QueueDropPolicy): QueueSettings => ({
    mode: "followup",
    debounceMs: 0,
    cap: 1,
    dropPolicy,
  });

  it.each(["old", "summarize"] as const)(
    "keeps an active single delivery out of %s overflow victims",
    async (dropPolicy) => {
      const key = createKey(dropPolicy);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const activeComplete = vi.fn();
      const pendingComplete = vi.fn();
      const calls: FollowupRun[] = [];
      const active = {
        ...createRun({ prompt: "active" }),
        queuedLifecycle: { onComplete: activeComplete },
      };
      const runFollowup = async (run: FollowupRun) => {
        calls.push(run);
        await run.queuedLifecycle?.onAdmitted?.();
        if (run === active) {
          entered.resolve();
          await release.promise;
        }
        completeFollowupRunLifecycle(run);
      };

      try {
        expect(
          enqueueFollowupRun(key, active, createSettings(dropPolicy), "none", runFollowup),
        ).toBe(true);
        await entered.promise;

        expect(getFollowupQueueDepth(key)).toBe(0);
        expect(
          enqueueFollowupRun(
            key,
            {
              ...createRun({ prompt: "pending" }),
              queuedLifecycle: { onComplete: pendingComplete },
            },
            createSettings(dropPolicy),
            "none",
          ),
        ).toBe(true);
        expect(
          enqueueFollowupRun(
            key,
            createRun({ prompt: "survivor" }),
            createSettings(dropPolicy),
            "none",
          ),
        ).toBe(true);

        const queue = getExistingFollowupQueue(key);
        expect(queue?.inFlight.has(active)).toBe(true);
        expect(queue?.items.map((item) => item.prompt)).toEqual(["active", "survivor"]);
        expect(getFollowupQueueDepth(key)).toBe(1);
        expect(activeComplete).not.toHaveBeenCalled();
        expect(pendingComplete).toHaveBeenCalledTimes(dropPolicy === "old" ? 1 : 0);
        expect(queue?.summarySources.map((item) => item.prompt)).toEqual(
          dropPolicy === "summarize" ? ["pending"] : [],
        );
      } finally {
        release.resolve();
      }

      await expect.poll(() => getExistingFollowupQueue(key)).toBeUndefined();
      expect(activeComplete).toHaveBeenCalledOnce();
      expect(pendingComplete).toHaveBeenCalledOnce();
      expect(calls.at(-1)?.prompt).toBe("survivor");
    },
  );

  it("admits one pending item under drop:new while another item is active", async () => {
    const key = createKey("new");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const rejectedEnqueued = vi.fn();
    const rejectedComplete = vi.fn();
    const active = createRun({ prompt: "active" });
    const runFollowup = async (run: FollowupRun) => {
      await run.queuedLifecycle?.onAdmitted?.();
      if (run === active) {
        entered.resolve();
        await release.promise;
      }
      completeFollowupRunLifecycle(run);
    };

    try {
      expect(enqueueFollowupRun(key, active, createSettings("new"), "none", runFollowup)).toBe(
        true,
      );
      await entered.promise;

      expect(getFollowupQueueDepth(key)).toBe(0);
      expect(
        enqueueFollowupRun(key, createRun({ prompt: "pending" }), createSettings("new"), "none"),
      ).toBe(true);
      expect(
        enqueueFollowupRun(
          key,
          {
            ...createRun({ prompt: "rejected" }),
            queuedLifecycle: {
              onEnqueued: rejectedEnqueued,
              onComplete: rejectedComplete,
            },
          },
          createSettings("new"),
          "none",
        ),
      ).toBe(false);

      expect(getFollowupQueueDepth(key)).toBe(1);
      expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
        "active",
        "pending",
      ]);
      expect(rejectedEnqueued).not.toHaveBeenCalled();
      expect(rejectedComplete).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
    }

    await expect.poll(() => getExistingFollowupQueue(key)).toBeUndefined();
  });

  it("protects a collect group and counts only active identities still present", async () => {
    const key = createKey("collect");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const groupCompletions = [vi.fn(), vi.fn()];
    const pendingComplete = vi.fn();
    const rejectedComplete = vi.fn();
    let aggregate: FollowupRun | undefined;
    const initialSettings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };
    const group = groupCompletions.map((onComplete, index) => ({
      ...createRun({
        prompt: `group-${index + 1}`,
        originatingChannel: "slack" as const,
        originatingTo: "channel:A",
        originatingChatType: "channel",
      }),
      queuedLifecycle: { onComplete },
    }));
    const runFollowup = async (run: FollowupRun) => {
      if (!aggregate) {
        aggregate = run;
        entered.resolve();
        await release.promise;
      }
      completeFollowupRunLifecycle(run);
    };

    for (const run of group) {
      expect(enqueueFollowupRun(key, run, initialSettings, "none", undefined, false)).toBe(true);
    }
    scheduleFollowupDrain(key, runFollowup);

    try {
      await entered.promise;
      const queue = getExistingFollowupQueue(key);
      expect(queue?.inFlight.size).toBe(2);
      expect(getFollowupQueueDepth(key)).toBe(0);

      const oldSettings: QueueSettings = { ...initialSettings, cap: 1, dropPolicy: "old" };
      expect(
        enqueueFollowupRun(
          key,
          {
            ...createRun({ prompt: "pending-old" }),
            queuedLifecycle: { onComplete: pendingComplete },
          },
          oldSettings,
          "none",
        ),
      ).toBe(true);
      expect(enqueueFollowupRun(key, createRun({ prompt: "survivor" }), oldSettings, "none")).toBe(
        true,
      );

      expect(queue?.items.map((item) => item.prompt)).toEqual(["group-1", "group-2", "survivor"]);
      expect(pendingComplete).toHaveBeenCalledOnce();
      expect(groupCompletions.map((complete) => complete.mock.calls.length)).toEqual([0, 0]);

      await aggregate?.queuedLifecycle?.onAdmitted?.();
      expect(queue?.items.map((item) => item.prompt)).toEqual(["survivor"]);
      expect(queue?.inFlight.size).toBe(2);
      expect(getFollowupQueueDepth(key)).toBe(1);

      expect(
        enqueueFollowupRun(
          key,
          {
            ...createRun({ prompt: "rejected-new" }),
            queuedLifecycle: { onComplete: rejectedComplete },
          },
          { ...initialSettings, cap: 1, dropPolicy: "new" },
          "none",
        ),
      ).toBe(false);
      expect(rejectedComplete).toHaveBeenCalledOnce();
      expect(getFollowupQueueDepth(key)).toBe(1);
    } finally {
      release.resolve();
    }

    await expect.poll(() => getExistingFollowupQueue(key)).toBeUndefined();
    expect(groupCompletions.map((complete) => complete.mock.calls.length)).toEqual([1, 1]);
  });
});

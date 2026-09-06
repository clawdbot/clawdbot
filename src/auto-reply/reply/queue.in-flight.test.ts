// Proves queue caps and depth describe pending work while active identities remain in shared state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  getFollowupQueueDepth,
  parkSteerCandidate,
  scheduleFollowupDrain,
} from "./queue.js";
import { createQueueTestRun as createRun } from "./queue.test-helpers.js";
import { prepareStaleFollowupDrainRetirement } from "./queue/drain.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
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

  it("drains accepted siblings after a cancelled parked steer is consumed", async () => {
    const key = createKey("cancelled-steer");
    const settings = createSettings("new");
    const controller = new AbortController();
    const delivered: string[] = [];
    const runFollowup = async (run: FollowupRun) => {
      if (!run.abortSignal?.aborted) {
        delivered.push(run.prompt);
      }
    };
    const steer = createRun({ prompt: "cancelled steer" });
    steer.abortSignal = controller.signal;
    steer.turnAdoptionLifecycle = { onAdopted: async () => {} };
    const parked = parkSteerCandidate(key, steer, settings, runFollowup);
    expect(parked).toBeDefined();
    expect(enqueueFollowupRun(key, createRun({ prompt: "ordinary sibling" }), settings)).toBe(true);
    scheduleFollowupDrain(key, runFollowup);
    await vi.waitFor(() => expect(getExistingFollowupQueue(key)?.draining).toBe(false));

    controller.abort();
    parked?.consume();

    await vi.waitFor(() => expect(delivered).toEqual(["ordinary sibling"]));
    await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
  });

  it("cancels a parked admission while its predecessor is still undecided", async () => {
    const key = createKey("cancelled-steer-wait");
    const settings = createSettings("new");
    const runFollowup = async () => {};
    const first = parkSteerCandidate(key, createRun({ prompt: "first" }), settings, runFollowup);
    const controller = new AbortController();
    const secondRun = createRun({ prompt: "second" });
    secondRun.abortSignal = controller.signal;
    secondRun.turnAdoptionLifecycle = { onAdopted: async () => {} };
    const second = parkSteerCandidate(key, secondRun, settings, runFollowup);
    if (!first || !second) {
      throw new Error("expected both steer reservations");
    }
    const admission = second.admit();
    let settled = false;
    const completion = admission.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      controller.abort();
      await vi.waitFor(() => expect(settled).toBe(true));
      await expect(admission).resolves.toBe("cancelled");
    } finally {
      first.consume();
      second.consume();
      await completion;
    }
  });

  it.each(["old", "summarize"] as const)(
    "keeps an active single delivery out of %s overflow victims",
    async (dropPolicy) => {
      const key = createKey(dropPolicy);
      const entered = createDeferred();
      const release = createDeferred();
      const activeComplete = vi.fn();
      const pendingComplete = vi.fn();
      const calls: FollowupRun[] = [];
      const active = {
        ...createRun({ prompt: "active" }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: activeComplete },
      };
      const runFollowup = async (run: FollowupRun) => {
        calls.push(run);
        await run.turnAdoptionLifecycle?.onAdopted?.();
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
              turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: pendingComplete },
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
    const entered = createDeferred();
    const release = createDeferred();
    const rejectedEnqueued = vi.fn();
    const rejectedComplete = vi.fn();
    const active = createRun({ prompt: "active" });
    const runFollowup = async (run: FollowupRun) => {
      await run.turnAdoptionLifecycle?.onAdopted?.();
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
            turnAdoptionLifecycle: {
              onAdopted: async () => {},
              onDeferred: rejectedEnqueued,
              onSettled: rejectedComplete,
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
    const entered = createDeferred();
    const release = createDeferred();
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
      turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
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
            turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: pendingComplete },
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

      await aggregate?.turnAdoptionLifecycle?.onAdopted?.();
      expect(queue?.items.map((item) => item.prompt)).toEqual(["survivor"]);
      expect(queue?.inFlight.size).toBe(2);
      expect(getFollowupQueueDepth(key)).toBe(1);

      expect(
        enqueueFollowupRun(
          key,
          {
            ...createRun({ prompt: "rejected-new" }),
            turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: rejectedComplete },
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

  it.each([false, true])(
    "moves pending overflow state without replaying active delivery (abort pending: %s)",
    async (abortPending) => {
      const key = createKey("summary-recovery");
      const settings: QueueSettings = {
        mode: "followup",
        debounceMs: 0,
        cap: 1,
        dropPolicy: "summarize",
      };
      const activeEntered = createDeferred();
      const releaseZombie = createDeferred();
      const calls: string[] = [];
      const pendingAbort = new AbortController();
      const pendingAbandoned = vi.fn();
      const pending = createRun({ prompt: "summary-pending" });
      pending.abortSignal = pendingAbort.signal;
      pending.turnAdoptionLifecycle = { onAdopted: async () => {}, onAbandoned: pendingAbandoned };
      const runFollowup = async (run: FollowupRun) => {
        calls.push(run.prompt);
        if (calls.length === 1) {
          activeEntered.resolve();
          await releaseZombie.promise;
        }
      };

      try {
        enqueueFollowupRun(
          key,
          createRun({ prompt: "summary-active" }),
          settings,
          "none",
          undefined,
          false,
        );
        enqueueFollowupRun(key, pending, settings, "none", undefined, false);
        scheduleFollowupDrain(key, runFollowup);
        await activeEntered.promise;
        enqueueFollowupRun(
          key,
          createRun({ prompt: "item-pending" }),
          settings,
          "none",
          runFollowup,
        );

        const retire = prepareStaleFollowupDrainRetirement(key);
        expect(retire).toBeTypeOf("function");
        retire?.();
        if (abortPending) {
          pendingAbort.abort();
          expect(pendingAbandoned).toHaveBeenCalledOnce();
        }
        await vi.waitFor(() => expect(calls).toHaveLength(abortPending ? 2 : 3));

        expect(calls[0]).toContain("summary-active");
        if (!abortPending) {
          expect(calls[1]).toContain("summary-pending");
        }
        expect(calls.at(-1)).toBe("item-pending");
        releaseZombie.resolve();
        await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
        expect(calls).toHaveLength(abortPending ? 2 : 3);
      } finally {
        releaseZombie.resolve();
      }
    },
  );

  it("rejects stale retirement after the same source enters a new drain generation", async () => {
    const key = createKey("generation-recovery");
    const settings = createSettings("old");
    const firstEntered = createDeferred();
    const secondEntered = createDeferred();
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const run = createRun({ prompt: "retry-same-source" });
    let attempts = 0;
    const runFollowup = async () => {
      attempts += 1;
      if (attempts === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
        throw new FollowupRunDeferredError();
      }
      secondEntered.resolve();
      await releaseSecond.promise;
    };

    try {
      enqueueFollowupRun(key, run, settings, "none", runFollowup);
      await firstEntered.promise;
      const queue = getExistingFollowupQueue(key);
      const retireFirstGeneration = prepareStaleFollowupDrainRetirement(key);
      releaseFirst.resolve();
      await secondEntered.promise;

      retireFirstGeneration?.();
      expect(getExistingFollowupQueue(key)).toBe(queue);
      expect(run.queueAbortSignal?.aborted).toBe(false);
      expect(attempts).toBe(2);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
    }
    await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
    expect(attempts).toBe(2);
  });
});

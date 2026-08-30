// Tests queue drain restart behavior when follow-up runs chain together.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { scheduleFollowupDrainAfterReplyOperationClear } from "./agent-runner-core.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resolveFollowupReplyDeliveryTargetKey } from "./queue/delivery-target.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import {
  consumeQueuedReplyCompletionHandoff,
  recordReplyOperationCompletedSourceReply,
  type ReplyCompletionHandoff,
} from "./reply-completion-handoff.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";

installQueueRuntimeErrorSilencer();

function createCompletionEligibleRun(key: string, prompt: string): FollowupRun {
  const queued = createRun({
    prompt,
    currentInboundEventKind: "user_request",
    originatingChannel: "telegram",
    originatingTo: "chat-1",
    originatingAccountId: "primary",
    originatingThreadId: 7,
  });
  queued.run.sessionKey = key;
  queued.run.sessionId = "session-1";
  queued.run.messageProvider = "telegram";
  queued.run.agentAccountId = "primary";
  queued.run.sourceReplyDeliveryMode = "message_tool_only";
  return queued;
}

function createCompletionHandoff(key: string): ReplyCompletionHandoff {
  return Object.freeze({
    kind: "completed_source_reply",
    ownerKey: key,
    ownerSessionId: "session-1",
    ownerLifecycleGeneration: getAgentEventLifecycleGeneration(),
    deliveryTargetKey: resolveFollowupReplyDeliveryTargetKey(
      createCompletionEligibleRun(key, "source"),
    ),
  });
}

function createCompletionConsumer(
  handoff: ReplyCompletionHandoff,
  overrides: Partial<Pick<ReplyOperation, "key" | "sessionId" | "lifecycleGeneration">> = {},
): ReplyOperation {
  return {
    key: overrides.key ?? handoff.ownerKey,
    sessionId: overrides.sessionId ?? handoff.ownerSessionId,
    lifecycleGeneration:
      overrides.lifecycleGeneration === undefined
        ? handoff.ownerLifecycleGeneration
        : overrides.lifecycleGeneration,
    result: null,
  } as unknown as ReplyOperation;
}

describe("followup queue drain restart after idle window", () => {
  it("keeps a detached drain on a live root after its enqueue request returns", async () => {
    resetGatewayWorkAdmission();
    const key = `test-detached-drain-root-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const parentReleased = createDeferred();
    const drained = createDeferred();
    const parent = tryBeginGatewayRootWorkAdmission();
    if (!parent) {
      throw new Error("expected parent Gateway work admission");
    }
    let suspensionStarted = false;
    let subordinateAdmissionClosed: boolean | undefined;
    let activeRootCountDuringDrain: number | undefined;
    let generationDuringDrain: unknown;
    const predecessorGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: {} as never,
    };

    try {
      await withPreparedModelRuntimePluginGenerationScope(predecessorGeneration, () =>
        parent.run(async () => {
          expect(getPreparedModelRuntimePluginGeneration()).toBe(predecessorGeneration);
          enqueueFollowupRun(key, createRun({ prompt: "detached" }), settings);
          scheduleFollowupDrain(key, async () => {
            await parentReleased.promise;
            const suspension = tryBeginGatewaySuspendAdmission(() => {});
            suspensionStarted = suspension !== null;
            try {
              generationDuringDrain = getPreparedModelRuntimePluginGeneration();
              subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
              activeRootCountDuringDrain = getActiveGatewayRootWorkCount();
            } finally {
              suspension?.rollback();
              drained.resolve();
            }
          });
        }),
      );

      parent.release();
      parentReleased.resolve();
      await drained.promise;

      expect(suspensionStarted).toBe(true);
      expect(subordinateAdmissionClosed).toBe(false);
      expect(activeRootCountDuringDrain).toBe(1);
      expect(generationDuringDrain).toBeUndefined();
      await vi.waitFor(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
    } finally {
      parent.release();
      parentReleased.resolve();
      clearSessionQueues([key]);
      resetGatewayWorkAdmission();
    }
  });

  it("releases a detached drain root when its queue is cleared during debounce", async () => {
    resetGatewayWorkAdmission();
    const env = captureEnv(["OPENCLAW_TEST_FAST"]);
    setTestEnvValue("OPENCLAW_TEST_FAST", "0");
    const key = `test-cleared-debounce-root-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 60_000, cap: 50 };

    try {
      enqueueFollowupRun(key, createRun({ prompt: "clear during debounce" }), settings);
      scheduleFollowupDrain(key, async () => {});
      await vi.waitFor(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      });

      clearSessionQueues([key]);

      await vi.waitFor(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
    } finally {
      clearSessionQueues([key]);
      env.restore();
      resetGatewayWorkAdmission();
    }
  });

  it("does not retain stale callbacks when scheduleFollowupDrain runs with an empty queue", async () => {
    const key = `test-no-stale-callback-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];
    const drained = createDeferred();

    scheduleFollowupDrain(key, async (run) => {
      staleCalls.push(run);
    });

    enqueueFollowupRun(key, createRun({ prompt: "after-empty-schedule" }), settings);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(staleCalls).toHaveLength(0);

    scheduleFollowupDrain(key, async (run) => {
      freshCalls.push(run);
      drained.resolve();
    });
    await drained.promise;

    expect(staleCalls).toHaveLength(0);
    expect(freshCalls).toHaveLength(1);
    expect(freshCalls[0]?.prompt).toBe("after-empty-schedule");
  });

  it("processes a message enqueued after the drain empties when enqueue refreshes the callback", async () => {
    const key = `test-idle-window-race-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const firstProcessed = createDeferred();
    const secondProcessed = createDeferred();
    let callCount = 0;
    const runFollowup = async (run: FollowupRun) => {
      callCount++;
      calls.push(run);
      if (callCount === 1) {
        firstProcessed.resolve();
      }
      if (callCount === 2) {
        secondProcessed.resolve();
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    await firstProcessed.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    enqueueFollowupRun(
      key,
      createRun({ prompt: "after-idle" }),
      settings,
      "message-id",
      runFollowup,
    );

    await secondProcessed.promise;

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("before-idle");
    expect(calls[1]?.prompt).toBe("after-idle");
  });

  it("restarts an idle drain with the newest followup callback", async () => {
    const key = `test-idle-window-fresh-callback-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];
    const firstProcessed = createDeferred();
    const secondProcessed = createDeferred();

    const staleFollowup = async (run: FollowupRun) => {
      staleCalls.push(run);
      if (staleCalls.length === 1) {
        firstProcessed.resolve();
      }
    };
    const freshFollowup = async (run: FollowupRun) => {
      freshCalls.push(run);
      secondProcessed.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
    scheduleFollowupDrain(key, staleFollowup);
    await firstProcessed.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    enqueueFollowupRun(
      key,
      createRun({ prompt: "after-idle" }),
      settings,
      "message-id",
      freshFollowup,
    );
    await secondProcessed.promise;

    expect(staleCalls).toHaveLength(1);
    expect(staleCalls[0]?.prompt).toBe("before-idle");
    expect(freshCalls).toHaveLength(1);
    expect(freshCalls[0]?.prompt).toBe("after-idle");
  });

  it("does not auto-start a drain when a busy run only refreshes the callback", async () => {
    const key = `test-busy-run-refreshes-callback-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];

    const staleFollowup = async (run: FollowupRun) => {
      staleCalls.push(run);
    };
    const freshFollowup = async (run: FollowupRun) => {
      freshCalls.push(run);
    };

    enqueueFollowupRun(
      key,
      createRun({ prompt: "queued-while-busy" }),
      settings,
      "message-id",
      freshFollowup,
      false,
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(freshCalls).toHaveLength(0);

    scheduleFollowupDrain(key, staleFollowup);
    await vi.waitFor(() => {
      expect(freshCalls).toHaveLength(1);
    });

    expect(staleCalls).toHaveLength(0);
    expect(freshCalls[0]?.prompt).toBe("queued-while-busy");
  });

  it("restarts an idle drain across distinct enqueue and drain module instances when enqueue refreshes the callback", async () => {
    const drainA = await importFreshModule<typeof import("./queue/drain.js")>(
      import.meta.url,
      "./queue/drain.js?scope=restart-a",
    );
    const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=restart-b",
    );
    const key = `test-idle-window-cross-module-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstProcessed = createDeferred();

    resetRecentQueuedMessageIdDedupe();

    try {
      const runFollowup = async (run: FollowupRun) => {
        calls.push(run);
        if (calls.length === 1) {
          firstProcessed.resolve();
        }
      };

      enqueueB.enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
      drainA.scheduleFollowupDrain(key, runFollowup);
      await firstProcessed.promise;

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      enqueueB.enqueueFollowupRun(
        key,
        createRun({ prompt: "after-idle" }),
        settings,
        "message-id",
        runFollowup,
      );

      await vi.waitFor(
        () => {
          expect(calls).toHaveLength(2);
        },
        { timeout: 1_000 },
      );

      expect(calls[0]?.prompt).toBe("before-idle");
      expect(calls[1]?.prompt).toBe("after-idle");
    } finally {
      clearSessionQueues([key]);
      drainA.clearFollowupDrainCallback(key);
      resetRecentQueuedMessageIdDedupe();
    }
  });

  it("does not double-drain when a message arrives while drain is still running", async () => {
    const key = `test-no-double-drain-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const allProcessed = createDeferred();
    let runFollowupResolve: (() => void) | undefined;
    const runFollowupGate = new Promise<void>((res) => {
      runFollowupResolve = res;
    });
    const runFollowup = async (run: FollowupRun) => {
      await runFollowupGate;
      calls.push(run);
      if (calls.length >= 2) {
        allProcessed.resolve();
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "first" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    enqueueFollowupRun(key, createRun({ prompt: "second" }), settings);
    if (!runFollowupResolve) {
      throw new Error("Expected followup run release callback to be initialized");
    }
    runFollowupResolve();

    await allProcessed.promise;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("first");
    expect(calls[1]?.prompt).toBe("second");
  });

  it("keeps a deferred followup queued and retries with the remembered callback", async () => {
    const key = `test-deferred-followup-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const retried = createDeferred();
    let attempts = 0;

    const runFollowup = async (run: FollowupRun) => {
      attempts++;
      calls.push(run);
      if (attempts === 1) {
        throw new FollowupRunDeferredError("reply lane busy");
      }
      retried.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "wait-for-lane" }), settings);
    scheduleFollowupDrain(key, runFollowup);

    await retried.promise;

    expect(attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("wait-for-lane");
    expect(calls[1]?.prompt).toBe("wait-for-lane");
  });

  it("refreshes the callback used by a deferred active-drain retry", async () => {
    const key = `test-active-drain-refreshes-retry-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const retried = createDeferred();
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];

    const staleFollowup = async (run: FollowupRun) => {
      staleCalls.push(run);
      firstStarted.resolve();
      await releaseFirst.promise;
      throw new FollowupRunDeferredError("reply lane busy");
    };
    const freshFollowup = async (run: FollowupRun) => {
      freshCalls.push(run);
      retried.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "wait-for-lane" }), settings);
    scheduleFollowupDrain(key, staleFollowup);
    await firstStarted.promise;

    scheduleFollowupDrain(key, freshFollowup);
    releaseFirst.resolve();
    await retried.promise;

    expect(staleCalls).toHaveLength(1);
    expect(freshCalls).toHaveLength(1);
    expect(freshCalls[0]?.prompt).toBe("wait-for-lane");
  });

  it.each([
    [true, "external_user", true],
    [true, "inter_session", false],
    [true, "internal_system", false],
    [false, "external_user", false],
  ] as const)(
    "preserves overflow summaries and human ownership for %s/%s",
    async (senderIsOwner, kind, owner) => {
      const key = `test-deferred-summary-retry-${Date.now()}`;
      const prompts: string[] = [];
      const followups: FollowupRun[] = [];
      const inputProvenance = { kind, sourceTool: "test" };
      const settings: QueueSettings = {
        mode: "followup",
        debounceMs: 0,
        cap: 1,
        dropPolicy: "summarize",
      };
      const retried = createDeferred();
      let attempts = 0;

      const runFollowup = async (run: FollowupRun) => {
        attempts++;
        prompts.push(run.prompt);
        followups.push(run);
        if (attempts === 1) {
          throw new FollowupRunDeferredError("reply lane busy");
        }
        retried.resolve();
      };

      for (const prompt of ["dropped while busy", "kept while busy"]) {
        const followup = createRun({ prompt });
        followup.run.senderIsOwner = senderIsOwner;
        followup.run.inputProvenance = inputProvenance;
        enqueueFollowupRun(key, followup, settings);
      }
      scheduleFollowupDrain(key, runFollowup);

      await retried.promise;

      expect(attempts).toBe(2);
      for (const run of followups) {
        expect(run).toMatchObject({
          run: { senderIsOwner, inputProvenance },
          userTurnTranscriptRecorder: {
            message: { provenance: inputProvenance, __openclaw: { senderIsOwner: owner } },
          },
        });
      }
      expect(prompts[0]).toContain("Dropped 1 message");
      expect(prompts[0]).toContain("dropped while busy");
      expect(prompts[1]).toContain("Dropped 1 message");
      expect(prompts[1]).toContain("dropped while busy");
    },
  );

  it.each([
    [true, "external_user", true],
    [true, "inter_session", false],
    [true, "internal_system", false],
    [false, "external_user", false],
  ] as const)("keeps collected human ownership for %s/%s", async (senderIsOwner, kind, owner) => {
    const key = `test-collected-human-owner-${Date.now()}`;
    const inputProvenance = { kind, sourceTool: "test" };
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const collected = createDeferred<FollowupRun>();
    for (const prompt of ["first", "second"]) {
      const followup = createRun({ prompt });
      followup.run.senderIsOwner = senderIsOwner;
      followup.run.inputProvenance = inputProvenance;
      followup.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
        input: { text: prompt, senderIsOwner, provenance: inputProvenance },
        target: {
          agentId: followup.run.agentId,
          sessionId: followup.run.sessionId,
          sessionKey: key,
          sessionEntry: undefined,
        },
      });
      enqueueFollowupRun(key, followup, settings);
    }
    scheduleFollowupDrain(key, async (run) => collected.resolve(run));
    const followup = await collected.promise;
    expect(followup.run.senderIsOwner).toBe(senderIsOwner);
    for (const message of [
      followup.userTurnTranscriptRecorder?.message,
      await followup.userTurnTranscriptRecorder?.resolveMessage(),
    ]) {
      expect(message).toMatchObject({
        provenance: inputProvenance,
        __openclaw: { senderIsOwner: owner },
      });
    }
  });

  it("merges overflow summaries added while a deferred retry is waiting", async () => {
    const key = `test-deferred-summary-merge-${Date.now()}`;
    const prompts: string[] = [];
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const retried = createDeferred();
    let attempts = 0;

    const runFollowup = async (run: FollowupRun) => {
      attempts++;
      prompts.push(run.prompt);
      if (attempts === 1) {
        enqueueFollowupRun(key, createRun({ prompt: "newer dropped while waiting" }), settings);
        enqueueFollowupRun(key, createRun({ prompt: "newer kept while waiting" }), settings);
        throw new FollowupRunDeferredError("reply lane busy");
      }
      retried.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "original dropped while busy" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "original kept while busy" }), settings);
    scheduleFollowupDrain(key, runFollowup);

    await retried.promise;

    expect(attempts).toBe(2);
    expect(prompts[1]).toContain("Dropped 3 messages");
    expect(prompts[1]).toContain("newer dropped while waiting");
    expect(prompts[1]).not.toContain("original dropped while busy");
  });

  it("bounds overflow identities across repeated deferred retries", async () => {
    const key = `test-deferred-summary-bound-${Date.now()}`;
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const completed = createDeferred();
    let retainedIdentityCount = 0;
    let attempts = 0;

    const runFollowup = async () => {
      attempts += 1;
      if (attempts === 3) {
        const queue = getExistingFollowupQueue(key);
        retainedIdentityCount =
          queue?.summaryElisions.reduce((count, entry) => count + entry.sources.length, 0) ?? 0;
        clearFollowupQueue(key);
        completed.resolve();
        return;
      }
      if (attempts <= 2) {
        enqueueFollowupRun(key, createRun({ prompt: `dropped on retry ${attempts}` }), settings);
        enqueueFollowupRun(key, createRun({ prompt: `kept on retry ${attempts}` }), settings);
        throw new FollowupRunDeferredError("reply lane busy");
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "original dropped" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "original kept" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    await completed.promise;

    expect(attempts).toBe(3);
    expect(retainedIdentityCount).toBeLessThanOrEqual(2);
  });

  it.each(["old", "new"] as const)(
    "drains a pending overflow summary after future drops switch to %s",
    async (dropPolicy) => {
      resetGatewayWorkAdmission();
      const key = `test-summary-policy-transition-${dropPolicy}-${Date.now()}`;
      const summarizeSettings: QueueSettings = {
        mode: "followup",
        debounceMs: 0,
        cap: 1,
        dropPolicy: "summarize",
      };
      const nonOutcomeAbandoned = vi.fn();
      const nonOutcomeDisposition = vi.fn();
      const nonOutcomeSettled = vi.fn();
      const createRecordedNonOutcome = (prompt: string) => {
        const run = createRun({ prompt });
        run.onQueueDisposition = nonOutcomeDisposition;
        run.turnAdoptionLifecycle = {
          admission: "cancel-only",
          onAdopted: vi.fn(),
          onAbandoned: nonOutcomeAbandoned,
          onSettled: nonOutcomeSettled,
        };
        return run;
      };
      const first = createRun({ prompt: "first overflowed message" });
      const second =
        dropPolicy === "old"
          ? createRecordedNonOutcome("second queued message")
          : createRun({ prompt: "second queued message" });
      const third =
        dropPolicy === "new"
          ? createRecordedNonOutcome("third rejected message")
          : createRun({ prompt: "third queued message" });
      const deliveredPrompts: string[] = [];
      let forcedCleanup = false;
      let timerFired = false;

      try {
        expect(enqueueFollowupRun(key, first, summarizeSettings)).toBe(true);
        expect(enqueueFollowupRun(key, second, summarizeSettings)).toBe(true);
        const queue = getExistingFollowupQueue(key);
        expect(queue).toMatchObject({
          dropPolicy: "summarize",
          droppedCount: 1,
          summaryLines: ["first overflowed message"],
        });
        expect(queue?.summarySources).toEqual([first]);
        expect(queue?.items).toEqual([second]);

        const admitted = enqueueFollowupRun(key, third, {
          ...summarizeSettings,
          dropPolicy,
        });
        expect(admitted).toBe(dropPolicy === "old");
        expect(getExistingFollowupQueue(key)).toBe(queue);
        expect(queue).toMatchObject({
          dropPolicy,
          droppedCount: 1,
          summaryLines: ["first overflowed message"],
        });
        expect(queue?.summarySources).toEqual([first]);
        expect(queue?.items).toEqual([dropPolicy === "old" ? third : second]);

        const timer = new Promise<void>((resolve) => {
          setTimeout(() => {
            timerFired = true;
            resolve();
          }, 0);
        });
        scheduleFollowupDrain(key, async (run) => {
          deliveredPrompts.push(run.prompt);
        });

        for (let pass = 0; pass < 2_000 && getExistingFollowupQueue(key); pass += 1) {
          await Promise.resolve();
        }
        if (getExistingFollowupQueue(key)) {
          forcedCleanup = true;
          clearSessionQueues([key]);
        }
        await timer;
        await vi.waitFor(() => {
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        });

        expect(forcedCleanup).toBe(false);
        expect(timerFired).toBe(true);
        expect(deliveredPrompts).toHaveLength(2);
        expect(deliveredPrompts[0]).toContain("[Queue overflow] Dropped 1 message due to cap.");
        expect(deliveredPrompts[0]).toContain("first overflowed message");
        expect(deliveredPrompts[1]).toBe(
          dropPolicy === "old" ? "third queued message" : "second queued message",
        );
        expect(nonOutcomeDisposition).toHaveBeenCalledWith(`queue-cap-${dropPolicy}`);
        expect(nonOutcomeAbandoned).toHaveBeenCalledOnce();
        expect(nonOutcomeSettled).toHaveBeenCalledTimes(1);
        expect(getExistingFollowupQueue(key)).toBeUndefined();
      } finally {
        clearSessionQueues([key]);
        resetGatewayWorkAdmission();
      }
    },
  );

  it("does not process messages after clearSessionQueues clears the callback", async () => {
    const key = `test-clear-callback-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const firstProcessed = createDeferred();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      firstProcessed.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-clear" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    await firstProcessed.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    clearSessionQueues([key]);

    enqueueFollowupRun(key, createRun({ prompt: "after-clear" }), settings);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("before-clear");
  });

  it("clears the remembered callback after a queue drains fully", async () => {
    const key = `test-auto-clear-callback-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstProcessed = createDeferred();

    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      firstProcessed.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    await firstProcessed.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    enqueueFollowupRun(key, createRun({ prompt: "after-idle" }), settings);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("before-idle");
  });
});

describe("followup queue completed-reply handoff", () => {
  it("does not let duplicate owner-clear callbacks erase the canonical handoff", async () => {
    const key = `test-completion-owner-clear-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const source = createCompletionEligibleRun(key, "A");
    const successor = createCompletionEligibleRun(key, "B");
    const owner = createReplyOperation({
      sessionKey: key,
      sessionId: "session-1",
      resetTriggered: false,
    });
    const done = createDeferred();
    let observed: ReplyCompletionHandoff | undefined;
    const runFollowup = async (queued: FollowupRun) => {
      const handoff = createCompletionHandoff(key);
      observed = consumeQueuedReplyCompletionHandoff(queued, createCompletionConsumer(handoff));
      done.resolve();
    };

    try {
      enqueueFollowupRun(key, successor, settings);
      recordReplyOperationCompletedSourceReply(owner, source);
      // Ordinary concurrent arrivals register distinct callbacks on one owner.
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: owner,
        queueKey: key,
        runFollowup: async (queued) => runFollowup(queued),
      });
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: owner,
        queueKey: key,
        runFollowup: async (queued) => runFollowup(queued),
      });
      owner.complete();

      await done.promise;
      expect(observed).toMatchObject({
        kind: "completed_source_reply",
        ownerKey: key,
        ownerSessionId: "session-1",
      });
    } finally {
      owner.complete();
      clearSessionQueues([key]);
    }
  });

  it("drops the handoff after the owner session rotates without dropping the queued request", async () => {
    const key = `test-completion-session-rotation-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const source = createCompletionEligibleRun(key, "A");
    const successor = createCompletionEligibleRun(key, "B");
    successor.run.sessionId = "session-2";
    const owner = createReplyOperation({
      sessionKey: key,
      sessionId: "session-1",
      resetTriggered: false,
    });
    const originalHandoff = createCompletionHandoff(key);
    const done = createDeferred();
    let observed: ReplyCompletionHandoff | undefined;

    try {
      enqueueFollowupRun(key, successor, settings);
      recordReplyOperationCompletedSourceReply(owner, source);
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: owner,
        queueKey: key,
        runFollowup: async (queued) => {
          observed = consumeQueuedReplyCompletionHandoff(
            queued,
            createCompletionConsumer(originalHandoff, { sessionId: "session-2" }),
          );
          done.resolve();
        },
      });
      owner.updateSessionId("session-2");
      owner.complete();

      await done.promise;
      expect(observed).toBeUndefined();
    } finally {
      owner.complete();
      clearSessionQueues([key]);
    }
  });

  it("replaces the active drain predecessor so A's fact reaches B and B's reaches C", async () => {
    const key = `test-completion-chain-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const predecessorA = createCompletionHandoff(key);
    const predecessorB = createCompletionHandoff(key);
    const observed: Array<ReplyCompletionHandoff | undefined> = [];
    const done = createDeferred();
    const operationB = createReplyOperation({
      sessionKey: key,
      sessionId: "session-1",
      resetTriggered: false,
    });

    try {
      enqueueFollowupRun(key, createCompletionEligibleRun(key, "B"), settings);
      enqueueFollowupRun(key, createCompletionEligibleRun(key, "C"), settings);

      scheduleFollowupDrain(
        key,
        async (queued) => {
          const expected = queued.prompt === "B" ? predecessorA : predecessorB;
          observed.push(
            consumeQueuedReplyCompletionHandoff(queued, createCompletionConsumer(expected)),
          );
          if (queued.prompt === "B") {
            // B completes while A's original drain callback still owns the loop.
            // Its after-clear path must replace A before that loop selects C.
            recordReplyOperationCompletedSourceReply(operationB, queued);
            scheduleFollowupDrainAfterReplyOperationClear({
              operation: operationB,
              queueKey: key,
              runFollowup: async () => {},
            });
            operationB.complete();
          } else {
            done.resolve();
          }
        },
        { predecessorHandoff: predecessorA },
      );

      await done.promise;
      expect(observed).toEqual([predecessorA, predecessorB]);
    } finally {
      operationB.complete();
      clearSessionQueues([key]);
    }
  });

  it("clears A's fact when B completes without a source reply before C runs", async () => {
    const key = `test-completion-chain-no-delivery-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const predecessorA = createCompletionHandoff(key);
    const observed: Array<[string, ReplyCompletionHandoff | undefined]> = [];
    const done = createDeferred();
    const operationB = createReplyOperation({
      sessionKey: key,
      sessionId: "session-1",
      resetTriggered: false,
    });

    try {
      enqueueFollowupRun(key, createCompletionEligibleRun(key, "B"), settings);
      enqueueFollowupRun(key, createCompletionEligibleRun(key, "C"), settings);

      scheduleFollowupDrain(
        key,
        async (queued) => {
          observed.push([
            queued.prompt,
            consumeQueuedReplyCompletionHandoff(queued, createCompletionConsumer(predecessorA)),
          ]);
          if (queued.prompt === "B") {
            // The canonical B owner-clear callback is claimed without a delivery
            // fact, replacing A before the still-active drain selects C.
            scheduleFollowupDrainAfterReplyOperationClear({
              operation: operationB,
              queueKey: key,
              runFollowup: async () => {},
            });
            operationB.complete();
          } else {
            done.resolve();
          }
        },
        { predecessorHandoff: predecessorA },
      );

      await done.promise;
      expect(observed).toEqual([
        ["B", predecessorA],
        ["C", undefined],
      ]);
    } finally {
      operationB.complete();
      clearSessionQueues([key]);
    }
  });

  it("preserves the predecessor across admission deferral and consumes it once on retry", async () => {
    const key = `test-completion-deferred-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const predecessor = createCompletionHandoff(key);
    const done = createDeferred();
    let attempts = 0;
    let observed: ReplyCompletionHandoff | undefined;

    try {
      enqueueFollowupRun(key, createCompletionEligibleRun(key, "deferred"), settings);
      scheduleFollowupDrain(
        key,
        async (queued) => {
          attempts += 1;
          if (attempts === 1) {
            throw new FollowupRunDeferredError("reply lane busy");
          }
          observed = consumeQueuedReplyCompletionHandoff(
            queued,
            createCompletionConsumer(predecessor),
          );
          done.resolve();
        },
        { predecessorHandoff: predecessor },
      );

      await done.promise;
      expect(attempts).toBe(2);
      expect(observed).toBe(predecessor);
    } finally {
      clearSessionQueues([key]);
    }
  });

  it("skips an aborted queue entry and hands the fact to the first executed successor", async () => {
    const key = `test-completion-aborted-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const predecessor = createCompletionHandoff(key);
    const aborted = createCompletionEligibleRun(key, "aborted");
    aborted.originatingTo = "foreign-aborted-route";
    const controller = new AbortController();
    controller.abort();
    aborted.queueAbortSignal = controller.signal;
    const observed: Array<[string, ReplyCompletionHandoff | undefined]> = [];
    const done = createDeferred();

    try {
      enqueueFollowupRun(key, aborted, settings);
      enqueueFollowupRun(key, createCompletionEligibleRun(key, "successor"), settings);
      scheduleFollowupDrain(
        key,
        async (queued) => {
          observed.push([
            queued.prompt,
            consumeQueuedReplyCompletionHandoff(queued, createCompletionConsumer(predecessor)),
          ]);
          if (queued.prompt === "successor") {
            done.resolve();
          }
        },
        { predecessorHandoff: predecessor },
      );

      await done.promise;
      expect(observed).toEqual([["successor", predecessor]]);
    } finally {
      clearSessionQueues([key]);
    }
  });

  it("drops a route-mismatched fact without suppressing or reclassifying either candidate", async () => {
    const key = `test-completion-route-mismatch-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const predecessor = createCompletionHandoff(key);
    const mismatched = createCompletionEligibleRun(key, "foreign route");
    mismatched.originatingTo = "chat-2";
    const observed: Array<[string, ReplyCompletionHandoff | undefined]> = [];
    const done = createDeferred();

    try {
      enqueueFollowupRun(key, mismatched, settings);
      enqueueFollowupRun(key, createCompletionEligibleRun(key, "later match"), settings);
      scheduleFollowupDrain(
        key,
        async (queued) => {
          observed.push([
            queued.prompt,
            consumeQueuedReplyCompletionHandoff(queued, createCompletionConsumer(predecessor)),
          ]);
          if (queued.prompt === "later match") {
            done.resolve();
          }
        },
        { predecessorHandoff: predecessor },
      );

      await done.promise;
      expect(observed).toEqual([
        ["foreign route", undefined],
        ["later match", undefined],
      ]);
    } finally {
      clearSessionQueues([key]);
    }
  });
});

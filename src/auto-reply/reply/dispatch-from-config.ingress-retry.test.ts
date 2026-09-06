import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindIngressLifecycleToReplyOptions,
  type ChannelIngressDispatchLifecycle,
} from "../../channels/message/ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "../../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  withTempState,
} from "../../channels/message/ingress-drain.test-helpers.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import { createDispatcher } from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import {
  withDispatchProcessedOutcomeSink,
  type DispatchProcessedNote,
} from "./dispatch-processed-outcome.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { clearSessionQueues, enqueueFollowupRun, type FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
  resetRecentQueuedMessageIdDedupe();
  vi.useFakeTimers();
});
afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  resetInboundDedupe();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("dispatch retry after queued ingress abandonment", () => {
  it.each(["watchdog-after-commit", "abandon-before-commit"] as const)(
    "delivers the same admitted message after %s and still suppresses a true duplicate",
    async (abandonment) => {
      await withTempState(async (stateDir) => {
        let clock = Date.now();
        const key = `agent:main:discord:direct:ingress-${abandonment}`;
        const messageId = `retry-${abandonment}`;
        const ctx = buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          From: "user:ingress-fixture",
          To: "channel:ingress-fixture",
          SessionKey: key,
          MessageSid: messageId,
          BodyForAgent: "Please deliver this queued message",
        });
        const queue = createTestIngressQueue(stateDir, { now: () => clock });
        await queue.enqueue(
          messageId,
          { text: "Please deliver this queued message" },
          { laneKey: key },
        );
        let dispatcher = createDispatcher();
        const outcomes: Array<DispatchProcessedNote | undefined> = [];
        const lifecycles: ChannelIngressDispatchLifecycle[] = [];
        const finishAbortedFollowup = vi.fn(async (run: FollowupRun) => {
          expect(run.abortSignal?.aborted).toBe(true);
        });
        const resolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
          if (resolver.mock.calls.length > 1) {
            return { text: "Queued message delivered" };
          }
          const run = createQueueTestRun({
            prompt: "Please deliver this queued message",
            messageId,
            originatingChannel: "discord",
            originatingTo: "channel:ingress-fixture",
          });
          run.turnAdoptionLifecycle = options?.turnAdoptionLifecycle;
          run.abortSignal = options?.turnAdoptionLifecycle?.abortSignal;
          expect(
            enqueueFollowupRun(
              key,
              run,
              {
                mode: "followup",
                debounceMs: 0,
                cap: 10,
                dropPolicy: "summarize",
              },
              "message-id",
              finishAbortedFollowup,
              false,
            ),
          ).toBe(true);
          if (abandonment === "watchdog-after-commit") {
            expect(
              enqueueFollowupRun(
                key,
                createQueueTestRun({
                  prompt: "Healthy pending sibling",
                  messageId: "healthy-sibling",
                }),
                { mode: "followup", debounceMs: 0 },
                "message-id",
                finishAbortedFollowup,
                false,
              ),
            ).toBe(true);
          }
          const runState = resolveReplyOperationRunState(options);
          if (!runState) {
            throw new Error("dispatch did not bind its run state");
          }
          runState.admission = { status: "accepted", mode: "followup" };
          if (abandonment === "abandon-before-commit") {
            clearSessionQueues([key]);
          }
          return undefined;
        });
        const drain = createChannelIngressDrain({
          queue,
          now: () => clock,
          adoptionStallTimeoutMs: 1_000,
          retryPolicy: { baseMs: 1, maxMs: 1 },
          dispatchClaimedEvent: async (_event, lifecycle) => {
            lifecycles.push(lifecycle);
            dispatcher = createDispatcher();
            const { processedOutcome } = await withDispatchProcessedOutcomeSink(() =>
              dispatchReplyFromConfig({
                ctx,
                cfg: automaticDirectReplyConfig,
                dispatcher,
                replyOptions: bindIngressLifecycleToReplyOptions(lifecycle),
                replyResolver: resolver,
              }),
            );
            outcomes.push(processedOutcome);
          },
        });
        try {
          await drain.drainOnce();
          await drain.waitForIdle();
          expect(resolver).toHaveBeenCalledOnce();
          expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
          if (abandonment === "watchdog-after-commit") {
            expect(await queue.listClaims()).toHaveLength(1);
            clock += 1_000;
            await vi.advanceTimersByTimeAsync(1_000);
            await drain.waitForIdle();
            expect(lifecycles[0]?.abortSignal.aborted).toBe(true);
          }
          expect(await queue.listPending()).toMatchObject([{ id: messageId, attempts: 1 }]);
          clock += 1_000;
          expect(await drain.drainOnce()).toEqual({ started: 1 });
          await drain.waitForIdle();
          // The old bug tombstones this retry as a duplicate without invoking the resolver.
          expect(resolver).toHaveBeenCalledTimes(2);
          if (abandonment === "watchdog-after-commit") {
            expect(finishAbortedFollowup).toHaveBeenCalledOnce();
            expect(getExistingFollowupQueue(key)?.items.map((run) => run.messageId)).toEqual([
              "healthy-sibling",
            ]);
          }
          expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
            text: "Queued message delivered",
          });
          expect(outcomes.at(-1)).toMatchObject({ outcome: "completed" });
          expect(await queue.listPending()).toEqual([]);
          expect(await queue.listClaims()).toEqual([]);
          expect((await queue.enqueue(messageId, { text: "duplicate" })).kind).toBe("completed");

          const duplicateDispatcher = createDispatcher();
          const duplicate = await withDispatchProcessedOutcomeSink(() =>
            dispatchReplyFromConfig({
              ctx,
              cfg: automaticDirectReplyConfig,
              dispatcher: duplicateDispatcher,
              replyResolver: resolver,
            }),
          );
          expect(duplicate.processedOutcome).toEqual({ outcome: "skipped", reason: "duplicate" });
          expect(resolver).toHaveBeenCalledTimes(2);
          expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
          expect(duplicateDispatcher.sendFinalReply).not.toHaveBeenCalled();
        } finally {
          drain.dispose();
          clearSessionQueues([key]);
        }
      });
    },
  );
});

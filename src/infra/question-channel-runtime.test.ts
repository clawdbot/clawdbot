// Covers question message finalization lifecycle and delivery races.
import { setImmediate as nextTurn } from "node:timers/promises";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { QuestionRecord } from "../../packages/gateway-protocol/src/schema/questions.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { createQuestionChannelRuntime } from "./question-channel-runtime-internal.js";

const record: QuestionRecord = {
  id: "ask_0123456789abcdef0123456789abcdef",
  status: "pending",
  questions: [
    {
      questionId: "target",
      header: "Target",
      question: "Deploy where?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
  createdAtMs: 1,
  expiresAtMs: 2,
};

describe("question channel runtime", () => {
  it.each(["known", "unbound"] as const)(
    "joins a %s finalizer that already started before clearing its local runtime",
    async (binding) => {
      const runtime = createQuestionChannelRuntime();
      const release = createDeferredCore();
      const events: string[] = [];
      const finalizerWork = release.promise.then(() => {
        events.push("finalizer settled");
      });
      const finalize = vi.fn(() => finalizerWork);
      let clearing: Promise<void[]> | undefined;
      try {
        const register = () =>
          runtime.registerDelivery({
            questionId: record.id,
            deliveryId: "held-finalizer",
            finalize,
          });
        if (binding === "known") {
          runtime.handleRequested(record);
          register();
          runtime.handleResolved({
            id: record.id,
            status: "answered",
            answers: { answers: { target: ["Production"] } },
          });
        } else {
          runtime.runWithDeliveries([record.id], register, { unbound: true });
        }
        expect(finalize).toHaveBeenCalledExactlyOnceWith(
          binding === "known" ? "Answered: Production" : "Unavailable: request a new question.",
        );

        clearing = Promise.all(
          [runtime.clear(), runtime.clear()].map((wait) =>
            Promise.resolve(wait).then(() => {
              events.push("runtime cleared");
            }),
          ),
        );
        await nextTurn();
        expect(events).toEqual([]);

        release.resolve();
        await clearing;
        expect(events).toEqual(["finalizer settled", "runtime cleared", "runtime cleared"]);
        expect(finalize).toHaveBeenCalledOnce();
        const nextFinalize = vi.fn();
        runtime.handleRequested(record);
        runtime.registerDelivery({
          questionId: record.id,
          deliveryId: "next-generation",
          finalize: nextFinalize,
        });
        runtime.handleResolved({ id: record.id, status: "expired" });
        expect(nextFinalize).toHaveBeenCalledExactlyOnceWith("Expired");
      } finally {
        release.resolve();
        // The baseline clear does not own this promise; join the original finalizer on red too.
        await finalizerWork;
        await clearing;
        await runtime.clear();
      }
    },
  );

  it.each(["known", "unbound"] as const)(
    "keeps a %s finalizer on its captured owner rather than its plugin caller",
    async (binding) => {
      const runtime = createQuestionChannelRuntime();
      const gateway = new AsyncWorkScope();
      const pluginCaller = new AsyncWorkScope();
      const otherGateway = new AsyncWorkScope();
      const release = createDeferredCore();
      const finalizerWork = release.promise;
      const finalize = vi.fn(() => finalizerWork);
      let gatewayDrained = false;
      let pluginDrained = false;
      let otherGatewayDrained = false;
      try {
        const register = () =>
          runtime.registerDelivery({ questionId: record.id, deliveryId: "late-plugin", finalize });
        if (binding === "known") {
          await gateway.track(() => {
            runtime.handleRequested(record);
            runtime.handleResolved({
              id: record.id,
              status: "answered",
              answers: { answers: { target: ["Production"] } },
            });
          });
          await pluginCaller.track(register);
        } else {
          await otherGateway.track(() => runtime.handleRequested(record));
          await gateway.track(() =>
            runtime.runWithDeliveries(
              [record.id],
              () => {
                gateway.beginClose();
                return pluginCaller.track(register);
              },
              { unbound: true },
            ),
          );
        }
        expect(finalize).toHaveBeenCalledExactlyOnceWith(
          binding === "known" ? "Answered: Production" : "Unavailable: request a new question.",
        );
        const closingGateway = gateway.drain().then(() => {
          gatewayDrained = true;
        });
        const closingPlugin = pluginCaller.drain().then(() => {
          pluginDrained = true;
        });
        const closingOtherGateway = otherGateway.drain().then(() => {
          otherGatewayDrained = true;
        });
        await nextTurn();
        expect(pluginDrained).toBe(true);
        expect(otherGatewayDrained).toBe(true);
        expect(gatewayDrained).toBe(false);

        release.resolve();
        await Promise.all([closingGateway, closingPlugin, closingOtherGateway]);
        expect(gatewayDrained).toBe(true);
        expect(finalize).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await finalizerWork;
        await runtime.clear();
        await Promise.all([gateway.drain(), pluginCaller.drain(), otherGateway.drain()]);
      }
    },
  );

  it("joins reentrant clear before releasing its finalizer and does not recreate a retention timer", async () => {
    vi.useFakeTimers();
    const runtime = createQuestionChannelRuntime();
    const release = createDeferredCore();
    let clearing: Promise<void> | undefined;
    try {
      runtime.handleRequested(record);
      runtime.registerDelivery({
        questionId: record.id,
        deliveryId: "reentrant-clear",
        finalize: () => {
          clearing = runtime.clear();
          return release.promise;
        },
      });
      runtime.handleResolved({ id: record.id, status: "expired" });
      expect(clearing).toBeDefined();
      expect(vi.getTimerCount()).toBe(0);
      release.resolve();
      await clearing;
    } finally {
      release.resolve();
      await clearing;
      await runtime.clear();
      vi.useRealTimers();
    }
  });

  it("retires only the closed Gateway after an admitted resolution and its finalizer join", async () => {
    const runtime = createQuestionChannelRuntime();
    const gateway = new AsyncWorkScope();
    const otherGateway = new AsyncWorkScope();
    const resolveQuestion = createDeferredCore();
    const releaseFinalizer = createDeferredCore();
    const releaseLateRequest = createDeferredCore();
    const finalize = vi.fn(() => releaseFinalizer.promise);
    const otherFinalize = vi.fn();
    const staleFinalize = vi.fn();
    const otherRecord = { ...record, id: "ask_other" };
    const lateRecord = { ...record, id: "ask_late" };
    let received: Promise<void> | undefined;
    let lateRequest: Promise<void> | undefined;
    let drained = false;
    try {
      await gateway.track(() => {
        runtime.handleRequested(record);
        runtime.registerDelivery({ questionId: record.id, deliveryId: "held", finalize });
        lateRequest = releaseLateRequest.promise.then(() => runtime.handleRequested(lateRecord));
      });
      await otherGateway.track(() => {
        runtime.handleRequested(otherRecord);
        runtime.registerDelivery({
          questionId: otherRecord.id,
          deliveryId: "other",
          finalize: otherFinalize,
        });
      });
      received = gateway.track(async () => {
        await resolveQuestion.promise;
        runtime.handleResolved({
          id: record.id,
          status: "answered",
          answers: { answers: { target: ["Production"] } },
        });
      });
      const closing = gateway.drain().then(() => {
        drained = true;
      });
      resolveQuestion.resolve();
      await received;
      await nextTurn();
      expect(finalize).toHaveBeenCalledExactlyOnceWith("Answered: Production");
      expect(drained).toBe(false);
      releaseFinalizer.resolve();
      await closing;
      runtime.retireGateway(gateway.signal);
      releaseLateRequest.resolve();
      await lateRequest;
      for (const questionId of [record.id, lateRecord.id]) {
        runtime.registerDelivery({ questionId, deliveryId: "stale", finalize: staleFinalize });
        runtime.handleResolved({ id: questionId, status: "expired" });
      }
      expect(staleFinalize).not.toHaveBeenCalled();
      runtime.handleResolved({ id: otherRecord.id, status: "expired" });
      expect(otherFinalize).toHaveBeenCalledExactlyOnceWith("Expired");
    } finally {
      resolveQuestion.resolve();
      releaseFinalizer.resolve();
      releaseLateRequest.resolve();
      await received;
      await lateRequest;
      await Promise.all([gateway.drain(), otherGateway.drain()]);
      runtime.retireGateway(gateway.signal);
      runtime.retireGateway(otherGateway.signal);
      await runtime.clear();
    }
  });

  it.each(["rooted", "unrooted"] as const)(
    "retains only an existing admission for a %s finalizer",
    async (mode) => {
      const runtime = createQuestionChannelRuntime();
      const release = createDeferredCore();
      const before = getActiveGatewayRootWorkCount();
      const admission = mode === "rooted" ? tryBeginGatewayRootWorkAdmission() : null;
      const deliver = async () => {
        runtime.handleRequested(record);
        runtime.registerDelivery({
          questionId: record.id,
          deliveryId: "root-retention",
          finalize: () => release.promise,
        });
        runtime.handleResolved({ id: record.id, status: "expired" });
      };
      try {
        if (mode === "rooted") {
          expect(admission).not.toBeNull();
        }
        await (admission ? admission.run(deliver) : deliver());
        admission?.release();
        expect(getActiveGatewayRootWorkCount()).toBe(before + (mode === "rooted" ? 1 : 0));
        release.resolve();
        await runtime.clear();
        expect(getActiveGatewayRootWorkCount()).toBe(before);
      } finally {
        release.resolve();
        admission?.release();
        await runtime.clear();
      }
    },
  );

  it("shares finalizers between separately evaluated gateway and plugin runtime modules", async () => {
    const gateway = await importFreshModule<typeof import("./question-channel-runtime.js")>(
      import.meta.url,
      "./question-channel-runtime.js?scope=question-gateway-owner",
    );
    const plugin = await importFreshModule<typeof import("./question-channel-runtime.js")>(
      import.meta.url,
      "./question-channel-runtime.js?scope=question-plugin-sdk",
    );
    const finalize = vi.fn();

    try {
      gateway.handleQuestionChannelRequested(record);
      plugin.registerQuestionChannelDelivery({
        questionId: record.id,
        deliveryId: "slack:default:C123:171234.001",
        finalize,
      });
      gateway.handleQuestionChannelResolved({
        id: record.id,
        status: "answered",
        answers: { answers: { target: ["Production"] } },
      });

      expect(finalize).toHaveBeenCalledExactlyOnceWith("Answered: Production");
    } finally {
      await drainGlobalSingletonLifecycleState("restart");
    }
  });

  it("clears shared callbacks and retention timers when the gateway restarts", async () => {
    vi.useFakeTimers();
    try {
      const gateway = await importFreshModule<typeof import("./question-channel-runtime.js")>(
        import.meta.url,
        "./question-channel-runtime.js?scope=question-gateway-lifecycle",
      );
      const staleFinalize = vi.fn();
      gateway.handleQuestionChannelRequested(record);
      gateway.registerQuestionChannelDelivery({
        questionId: record.id,
        deliveryId: "slack:default:C123:171234.002",
        finalize: staleFinalize,
      });
      gateway.handleQuestionChannelRequested({ ...record, id: "ask_terminal" });
      gateway.handleQuestionChannelResolved({ id: "ask_terminal", status: "expired" });

      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await drainGlobalSingletonLifecycleState("restart");
      expect(vi.getTimerCount()).toBe(0);

      gateway.handleQuestionChannelResolved({ id: record.id, status: "cancelled" });
      expect(staleFinalize).not.toHaveBeenCalled();
    } finally {
      await drainGlobalSingletonLifecycleState("restart");
      vi.useRealTimers();
    }
  });

  it("finalizes delivered messages once with canonical answer labels", async () => {
    const finalize = vi.fn();
    const runtime = createQuestionChannelRuntime();
    runtime.handleRequested(record);
    runtime.registerDelivery({ questionId: record.id, deliveryId: "telegram:1", finalize });

    const event = {
      id: record.id,
      status: "answered" as const,
      answers: { answers: { target: ["Production"] } },
    };
    runtime.handleResolved(event);
    runtime.handleResolved(event);
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());
    expect(finalize).toHaveBeenCalledWith("Answered: Production");
    await runtime.clear();
  });

  it("finalizes expiry delivered after the terminal event", async () => {
    const finalize = vi.fn();
    const runtime = createQuestionChannelRuntime();
    runtime.handleRequested(record);
    runtime.handleResolved({ id: record.id, status: "expired" });
    runtime.registerDelivery({ questionId: record.id, deliveryId: "slack:1", finalize });

    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());
    expect(finalize).toHaveBeenCalledWith("Expired");
    await runtime.clear();
  });

  it("does not echo free-text answers", async () => {
    const finalize = vi.fn();
    const runtime = createQuestionChannelRuntime();
    runtime.handleRequested({
      ...record,
      questions: [{ ...record.questions[0]!, options: [], isOther: true }],
    });
    runtime.registerDelivery({ questionId: record.id, deliveryId: "telegram:text", finalize });
    runtime.handleResolved({
      id: record.id,
      status: "answered",
      answers: { answers: { target: ["@everyone secret-ish text"] } },
    });

    await vi.waitFor(() => expect(finalize).toHaveBeenCalledWith("Answered"));
    await runtime.clear();
  });

  it("retains terminal state beyond the gateway grace for late delivery capture", async () => {
    vi.useFakeTimers();
    try {
      const finalize = vi.fn();
      const runtime = createQuestionChannelRuntime();
      runtime.handleRequested(record);
      runtime.handleResolved({ id: record.id, status: "expired" });
      await vi.advanceTimersByTimeAsync(15_001);
      runtime.registerDelivery({ questionId: record.id, deliveryId: "slack:late", finalize });

      expect(finalize).toHaveBeenCalledWith("Expired");
      await runtime.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reuse a retained terminal decision for a newly accepted question with the same id", async () => {
    const runtime = createQuestionChannelRuntime();
    const finalize = vi.fn();
    try {
      runtime.handleRequested(record);
      runtime.handleResolved({
        id: record.id,
        status: "answered",
        answers: { answers: { target: ["Production"] } },
      });
      runtime.handleRequested({ ...record, createdAtMs: 20_000, expiresAtMs: 30_000 });
      runtime.registerDelivery({ questionId: record.id, deliveryId: "new-question", finalize });
      expect(finalize).not.toHaveBeenCalled();
      runtime.handleResolved({ id: record.id, status: "expired" });
      expect(finalize).toHaveBeenCalledExactlyOnceWith("Expired");
    } finally {
      await runtime.clear();
    }
  });

  it.each([
    { binding: "known", retirement: "clear", deliveryOwner: "question" },
    { binding: "known", retirement: "gateway retirement", deliveryOwner: "question" },
    { binding: "known", retirement: "gateway retirement", deliveryOwner: "plugin" },
    { binding: "known", retirement: "retention expiry", deliveryOwner: "question" },
    { binding: "unbound", retirement: "clear", deliveryOwner: "question" },
    { binding: "unbound", retirement: "gateway retirement", deliveryOwner: "question" },
  ] as const)(
    "does not revive a captured $binding delivery from $deliveryOwner scope after $retirement",
    async ({ binding, retirement, deliveryOwner }) => {
      vi.useFakeTimers();
      const runtime = createQuestionChannelRuntime({ terminalRetentionMs: 50 });
      const gateway = new AsyncWorkScope();
      const pluginCaller = new AsyncWorkScope();
      const capturingScope = deliveryOwner === "question" ? gateway : pluginCaller;
      const release = createDeferredCore();
      const staleFinalize = vi.fn();
      const nextFinalize = vi.fn();
      let delivery: Promise<void> | undefined;
      try {
        await gateway.track(() => runtime.handleRequested(record));
        runtime.handleResolved({ id: record.id, status: "expired" });
        await capturingScope.track(() => {
          delivery = runtime.runWithDeliveries(
            [record.id],
            async () => {
              await release.promise;
              await pluginCaller.track(() =>
                runtime.runWithDeliveries(
                  [record.id],
                  () =>
                    runtime.registerDelivery({
                      questionId: record.id,
                      deliveryId: "old-message",
                      finalize: staleFinalize,
                    }),
                  { unbound: binding === "unbound" },
                ),
              );
            },
            { unbound: binding === "unbound" },
          );
        });
        if (retirement === "clear") {
          await runtime.clear();
        } else if (retirement === "gateway retirement") {
          await gateway.drain();
          runtime.retireGateway(gateway.signal);
        }
        runtime.handleRequested({ ...record, createdAtMs: 20, expiresAtMs: 100 });
        if (retirement === "retention expiry") {
          await vi.advanceTimersByTimeAsync(50);
        }
        release.resolve();
        await delivery;
        runtime.registerDelivery({
          questionId: record.id,
          deliveryId: "new-message",
          finalize: nextFinalize,
        });
        runtime.handleResolved({ id: record.id, status: "cancelled" });
        if (retirement === "retention expiry") {
          expect(staleFinalize).toHaveBeenCalledExactlyOnceWith(
            "Unavailable: request a new question.",
          );
        } else {
          expect(staleFinalize).not.toHaveBeenCalled();
        }
        expect(nextFinalize).toHaveBeenCalledExactlyOnceWith("Cancelled");
      } finally {
        release.resolve();
        await delivery;
        await Promise.all([gateway.drain(), pluginCaller.drain()]);
        await runtime.clear();
        const remainingTimers = vi.getTimerCount();
        vi.useRealTimers();
        expect(remainingTimers).toBe(0);
      }
    },
  );

  it("reports finalizer failures without retrying a double resolve", async () => {
    const error = new Error("edit failed");
    const onFinalizeError = vi.fn();
    const runtime = createQuestionChannelRuntime({ onFinalizeError });
    runtime.handleRequested(record);
    runtime.registerDelivery({
      questionId: record.id,
      deliveryId: "discord:1",
      finalize: () => {
        throw error;
      },
    });
    runtime.handleResolved({ id: record.id, status: "cancelled" });
    runtime.handleResolved({ id: record.id, status: "cancelled" });

    await vi.waitFor(() => expect(onFinalizeError).toHaveBeenCalledOnce());
    expect(onFinalizeError).toHaveBeenCalledWith(error, record.id, "discord:1");
    await runtime.clear();
  });
});

describe("terminal status labels", () => {
  it("echoes declared option answers even when free-text input was allowed", async () => {
    const recordWithOther: QuestionRecord = {
      id: "ask_q",
      questions: [
        {
          questionId: "deploy",
          header: "Deploy",
          question: "Where?",
          options: [{ label: "Staging" }, { label: "Production" }],
          isOther: true,
        },
      ],
      createdAtMs: 1,
      expiresAtMs: 2,
      status: "answered",
      answers: { answers: { deploy: ["Staging"] } },
    };
    const finalize = vi.fn();
    const runtime = createQuestionChannelRuntime();
    runtime.handleRequested(recordWithOther);
    runtime.registerDelivery({ questionId: recordWithOther.id, deliveryId: "test:1", finalize });
    runtime.handleResolved({
      id: "ask_q",
      status: "answered",
      answers: { answers: { deploy: ["Staging"] } },
    });

    await vi.waitFor(() => expect(finalize).toHaveBeenCalledWith("Answered: Staging"));
    await runtime.clear();
  });
});

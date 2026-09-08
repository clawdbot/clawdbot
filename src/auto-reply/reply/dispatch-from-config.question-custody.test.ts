import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import {
  createDispatcher,
  diagnosticMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  createReplyOperation,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  replyRunRegistry,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/types.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});
afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  resetInboundDedupe();
  clearAgentHarnesses();
});

function createQuestionDispatch(name: string) {
  const key = `agent:main:discord:direct:question-${name}`;
  const sessionId = `question-${name}`;
  sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
  const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  const cancel = vi.fn();
  operation.attachBackend({ kind: "cli", runId: "independent-question-run", cancel });
  operation.setPhase("running");
  return {
    operation,
    cancel,
    ctx: buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: "user:question-fixture",
      To: "channel:question-fixture",
      SessionKey: key,
      MessageSid: `question-answer-${name}`,
      BodyForAgent: "answer",
    }),
  };
}

describe("dispatch input custody after a question response", () => {
  // Real question/receipt classification is covered by the wire regression. Here
  // the real dispatch owner must preserve that recorded fact through source faults.
  it.each(
    ["confirmed", "indeterminate"].flatMap((outcome) =>
      ["settlement-error", "source-abort"].map((failure) => ({ outcome, failure })),
    ),
  )("does not replay $outcome input after $failure", async ({ outcome, failure }) => {
    const fixture = createQuestionDispatch(`${outcome}-${failure}`);
    const abort = new AbortController();
    const cleanupError = new Error("source settlement failed");
    const onAdopted = vi.fn(async () => {
      throw new Error("source adoption closed");
    });
    const onSettled = vi.fn(() => {
      if (failure === "source-abort") {
        abort.abort();
      } else {
        throw cleanupError;
      }
    });
    const resolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const state = resolveReplyOperationRunState(opts);
      if (!state) {
        throw new Error("missing dispatch run state");
      }
      state.admission =
        outcome === "confirmed"
          ? { status: "accepted", mode: "steer" }
          : { status: "skipped", reason: "question-response-indeterminate" };
      const input = { turnAdoptionLifecycle: opts?.turnAdoptionLifecycle };
      await admitFollowupRunLifecycle(input).catch(() => {});
      completeFollowupRunLifecycle(input, "consumed");
      return undefined;
    });
    try {
      const first = dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyOptions: {
          abortSignal: abort.signal,
          turnAdoptionLifecycle: { onAdopted, onSettled },
        },
        replyResolver: resolver,
      });
      if (failure === "settlement-error") {
        await expect(first).rejects.toBe(cleanupError);
      } else {
        await expect(first).resolves.toMatchObject({ queuedFinal: false });
      }
      const replay = vi.fn(async () => ({ text: "must not replay" }));
      await dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
        replyResolver: replay,
      });
      expect(replay).not.toHaveBeenCalled();
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(fixture.cancel).not.toHaveBeenCalled();
      expect(fixture.operation.result).toBeNull();
      expect(replyRunRegistry.get(fixture.operation.key)).toBe(fixture.operation);
    } finally {
      fixture.operation.complete();
    }
  });

  it.each(["question-response-indeterminate", "question-response-refused"] as const)(
    "delivers %s and records an error instead of a successful agent turn",
    async (reason) => {
      const fixture = createQuestionDispatch(reason);
      const dispatcher = createDispatcher();
      const notice =
        reason === "question-response-indeterminate"
          ? "The question answer could not be confirmed; check before retrying."
          : "The question answer was refused; check your permissions before retrying.";
      try {
        await dispatchReplyFromConfig({
          ctx: fixture.ctx,
          cfg: { ...automaticDirectReplyConfig, diagnostics: { enabled: true } },
          dispatcher,
          replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
          replyResolver: async (_ctx, opts) => {
            const state = resolveReplyOperationRunState(opts);
            if (!state) {
              throw new Error("missing dispatch run state");
            }
            state.admission = { status: "skipped", reason };
            return { text: notice, isError: true };
          },
        });
        expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: notice, isError: true });
        expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "error", reason }),
        );
        expect(fixture.cancel).not.toHaveBeenCalled();
        expect(fixture.operation.result).toBeNull();
      } finally {
        fixture.operation.complete();
      }
    },
  );

  it("delivers a host question refusal when the agent owns normal replies", async () => {
    const fixture = createQuestionDispatch("host-refusal");
    const dispatcher = createDispatcher();
    const question = registerPendingAgentQuestion({
      sessionKey: fixture.operation.key,
      questionId: "ask_unbound_source",
      questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
      answer: Promise.resolve({ status: "pending" }),
    });
    question.attachRegistration(Promise.resolve());
    try {
      await dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher,
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          turnAdoptionLifecycle: { onAdopted: async () => {} },
        },
        replyResolver: async (ctx, opts) => {
          const result = await runReplyQuestionInput({
            commandBody: "answer",
            followupRun: createQueueTestRun({ prompt: "answer" }),
            sessionKey: fixture.operation.key,
            sessionCtx: ctx,
            opts,
          });
          expect(result.handled).toBe(true);
          return result.handled ? result.payload : undefined;
        },
      });
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("The answer was not sent"),
          isError: true,
        }),
      );
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      question.dispose();
      fixture.operation.complete();
    }
  });

  it("still permits retry when the source failed before any input custody transfer", async () => {
    const fixture = createQuestionDispatch("before-custody");
    const error = new Error("failure before input dispatch");
    try {
      await expect(
        dispatchReplyFromConfig({
          ctx: fixture.ctx,
          cfg: automaticDirectReplyConfig,
          dispatcher: createDispatcher(),
          replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
          replyResolver: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      const retry = vi.fn(async () => ({ text: "retry is safe" }));
      await dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
        replyResolver: retry,
      });
      expect(retry).toHaveBeenCalledOnce();
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      fixture.operation.complete();
    }
  });
});

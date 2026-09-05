import { describe, expect, it, vi } from "vitest";
import type { QuestionWaitAnswerResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  claimEmbeddedPendingUserInputAnswer,
  steerActiveSessionWithOptionalDeliveryWait,
} from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  callGatewayTool,
  withQuestionGateway,
} from "../../agents/harness/gateway-question.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import type { GatewayQuestionCall } from "../../agents/tools/gateway-question-lifecycle.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { clearSessionQueues, enqueueFollowupRun, type FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

const text = "candidate committed answer";
type QueueOptions = Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[2];

// A V1 translator built against v2026.8.2's closed request schemas. The real
// transport/manager still commits and answers; only new receipt fields are absent.
const legacyGateway: GatewayQuestionCall = (method, options, params, extra) => {
  const input = params as Record<string, unknown>;
  const forwarded =
    method === "question.resolve"
      ? { id: input.id, answers: input.answers, resolvedBy: input.resolvedBy }
      : method === "question.waitAnswer"
        ? { id: input.id, timeoutMs: input.timeoutMs }
        : params;
  return callGatewayTool(method, options, forwarded, extra);
};

// Old wire schemas do not remove the modern host's final-dispatch obligation.
const legacyDispatcher: AgentQuestionDispatcher = {
  version: 2,
  call: ({ method, options, params, signal, authority }) =>
    legacyGateway(method, options, params, {
      signal,
      ...(authority.kind === "source-bound"
        ? { dispatchAuthority: { version: 2, ...authority } }
        : {}),
    }),
};

async function withQuestionCreator(
  key: string,
  run: FollowupRun,
  test: (operation: ReturnType<typeof createReplyOperation>, fingerprint: string) => Promise<void>,
) {
  run.run.agentId = "main";
  run.run.sessionKey = key;
  const runId = "accepted-backing-work";
  const operation = createReplyOperation({
    sessionKey: key,
    sessionId: run.run.sessionId,
    resetTriggered: false,
  });
  operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
  const fingerprint = operation.bindToolAuthorityRoute({
    provider: run.run.provider,
    model: run.run.model,
  });
  const admission = prepareAgentRunAdmission({
    cfg: run.run.config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      agentId: "main",
      runId,
      ingress: { kind: "system", state: "present", boundary: "question-custody-test" },
    },
  });
  try {
    await withPreparedEmbeddedRunToolAuthority(
      {
        admittedRunContext: await admission.admit("embedded", "question-custody-test"),
        replyOperation: operation,
      },
      {
        ...run.run,
        runId,
        modelId: run.run.model,
        toolAuthorityFingerprint: fingerprint,
        abortSignal: operation.abortSignal,
      },
      undefined,
      () => test(operation, fingerprint),
    );
  } finally {
    operation.complete();
    admission.close();
  }
}

describe("question response custody through reply adoption", () => {
  it.each(["next-model", "tool-cap", "permission", "sender", "source-closure"] as const)(
    "uses creator policy and incoming source authority for %s",
    async (change) => {
      const key = `agent:main:question-caller-${change}`;
      const run = createQueueTestRun({ prompt: text });
      run.run.senderIsOwner = true;
      run.run.traceAuthorized = true;
      run.run.messageProvider = "webchat";
      run.run.config = { tools: { toolsBySender: { "*": { allow: [] } } } };
      await withQuestionCreator(key, run, async (operation) => {
        const source = new AbortController();
        const committed = vi.fn();
        const gatewayCall: AgentQuestionDispatcher = {
          version: 2,
          call: async ({ authority }) => {
            expect(authority.kind).toBe("source-bound");
            await Promise.resolve();
            if (change === "source-closure") {
              source.abort();
            }
            if (authority.kind === "source-bound") {
              authority.assertCurrent();
            }
            committed();
            return { status: "answered" };
          },
        };
        const claim = registerPendingAgentQuestion({
          questionId: `ask_caller_${change}`,
          sessionKey: key,
          questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
          gatewayCall,
          answer: Promise.resolve({ status: "pending" }),
        });
        claim.attachRegistration(Promise.resolve());
        const adopted = vi.fn(async () => {});
        const settled = vi.fn();
        const state: ReplyOperationRunState = {};
        const incoming: FollowupRun = {
          ...run,
          toolsAllow: change === "tool-cap" ? [] : undefined,
          turnAdoptionLifecycle: { onAdopted: adopted, onSettled: settled },
          run: {
            ...run.run,
            // A next-turn route never replaces the still-active question creator.
            provider: "next-provider",
            model: "next-model",
            senderIsOwner: change !== "sender",
          },
        };
        try {
          const result = await runReplyQuestionInput({
            commandBody: text,
            followupRun: incoming,
            sessionKey: key,
            sessionCtx: { Provider: "webchat" },
            sessionEntry:
              change === "permission"
                ? { sessionId: run.run.sessionId, updatedAt: 0, permissionMode: "guarded" }
                : undefined,
            opts: { abortSignal: source.signal, [REPLY_OPERATION_RUN_STATE]: state },
          });
          expect(operation.result).toBeNull();
          if (change === "next-model") {
            expect(result).toEqual({ handled: true, payload: undefined });
            expect(committed).toHaveBeenCalledOnce();
            expect(adopted).toHaveBeenCalledOnce();
            expect(settled).toHaveBeenCalledOnce();
          } else {
            expect(result).toMatchObject({ handled: true, payload: { isError: true } });
            expect(state.admission).toEqual({
              status: "skipped",
              reason: "question-response-refused",
            });
            expect(committed).not.toHaveBeenCalled();
            expect(adopted).not.toHaveBeenCalled();
            expect(settled).not.toHaveBeenCalled();
            expect(claim.isResolving()).toBe(false);
          }
        } finally {
          claim.dispose();
        }
      });
    },
  );

  it.each(
    [
      "delayed-receipt",
      "failed-waiter",
      "legacy-receipt",
      "v1-negative",
      "closed-adoption",
      "confirmed-closed-adoption",
    ].flatMap((mode) =>
      (["steer", "reply"] as const)
        .filter((entrypoint) => mode !== "v1-negative" || entrypoint === "steer")
        .map((entrypoint) => ({ entrypoint, mode })),
    ),
  )(
    "does not replay or abort independent work after $entrypoint/$mode",
    async ({ entrypoint, mode }) => {
      const key = `agent:main:question-recovery-${entrypoint}-${mode}`;
      const id = `ask_recovery_${entrypoint}_${mode}`;
      const run = createQueueTestRun({ prompt: text, messageId: `recovery-${mode}` });
      await withQuestionGateway(async (fixture) =>
        withQuestionCreator(key, run, async (operation, fingerprint) => {
          const hold = fixture.holdWaitAnswerResponse();
          const call = mode === "legacy-receipt" ? legacyGateway : callGatewayTool;
          const questions = [
            { id: "answer", header: "Answer", question: "Continue?", isOther: true, options: [] },
          ];
          const claim = registerPendingAgentQuestion({
            questionId: id,
            sessionKey: key,
            questions,
            gatewayCall: mode === "legacy-receipt" ? legacyDispatcher : undefined,
          });
          const registration = call(
            "question.request",
            {},
            {
              id,
              sessionKey: key,
              timeoutMs: 60_000,
              questions: questions.map((question) => ({
                questionId: question.id,
                header: question.header,
                question: question.question,
                isOther: question.isOther,
                options: question.options,
              })),
            },
          );
          claim.attachRegistration(registration);
          await registration;
          const answer = call(
            "question.waitAnswer",
            { timeoutMs: 70_000 },
            { id, timeoutMs: 60_000, includeResolutionId: true },
          ) as Promise<QuestionWaitAnswerResult>;
          const answerOutcome = answer.catch(() => undefined);
          claim.setAnswer(answer);
          await fixture.waitStarted;
          const abandoned = vi.fn();
          const settled = vi.fn();
          const adopted = vi.fn(async () => {
            if (mode === "closed-adoption" || mode === "confirmed-closed-adoption") {
              throw new Error("source adoption closed after dispatch");
            }
          });
          run.turnAdoptionLifecycle = {
            onAdopted: adopted,
            onAbandoned: abandoned,
            onSettled: settled,
          };
          const cancel = vi.fn(() => fixture.backingRun.abort());
          const nativeSteer = vi.fn(async () => {
            throw new Error("unexpected ordinary steering of an answered question");
          });
          const subscribe = vi.fn(() => () => {});
          const queue = async (
            message: string,
            options: QueueOptions,
            assertCurrent: () => void,
            kind: "run" | "source-bound",
          ) => {
            try {
              return await steerActiveSessionWithOptionalDeliveryWait(
                { steer: nativeSteer, subscribe },
                message,
                options,
                key,
                () => {
                  assertCurrent();
                  return true;
                },
                { kind, assertCurrent },
              );
            } catch (error) {
              if (mode === "v1-negative") {
                options?.onQueueAccepted?.(false);
              }
              throw error;
            }
          };
          const assertCurrent = () => {
            expect(replyRunRegistry.get(key)).toBe(operation);
            operation.abortSignal.throwIfAborted();
          };
          operation.attachBackend({
            kind: entrypoint === "reply" ? "cli" : "embedded",
            runId: "accepted-backing-work",
            toolAuthorityFingerprint: fingerprint,
            cancel,
            ...(entrypoint === "reply"
              ? {}
              : mode === "v1-negative"
                ? {
                    messageInjection: {
                      isAvailable: () => true,
                      queueMessage: (message, options) =>
                        queue(message, options, assertCurrent, "run"),
                    },
                  }
                : {
                    messageInjectionV2: {
                      version: 2 as const,
                      isAvailable: () => true,
                      queueMessage: queue,
                      claimPendingUserInputAnswer: (message, options, current, kind) =>
                        claimEmbeddedPendingUserInputAnswer(
                          message,
                          options,
                          key,
                          () => {
                            current();
                            return true;
                          },
                          { kind, assertCurrent: current },
                        ),
                    },
                  }),
          });
          operation.setPhase("running");
          const confirmed = mode === "delayed-receipt" || mode === "confirmed-closed-adoption";
          if (mode !== "confirmed-closed-adoption") {
            fixture.dropNextResolveResponse();
          }
          const state: ReplyOperationRunState = {};
          const followup = vi.fn(async (_run: FollowupRun) => {});
          const typing = createMockTypingController();
          let done = false;
          const adoption = (
            entrypoint === "reply"
              ? runReplyAgent({
                  commandBody: text,
                  transcriptCommandBody: text,
                  followupRun: run,
                  opts: {
                    [REPLY_OPERATION_RUN_STATE]: state,
                    turnAdoptionLifecycle: run.turnAdoptionLifecycle,
                  },
                  queueKey: key,
                  resolvedQueue: { mode: "steer", debounceMs: 0 },
                  shouldSteer: true,
                  shouldFollowup: false,
                  isActive: true,
                  typing,
                  sessionCtx: {},
                  sessionKey: key,
                  defaultModel: "openai/gpt-test",
                  resolvedVerboseLevel: "off",
                  isNewSession: false,
                  blockStreamingEnabled: false,
                  resolvedBlockStreamingBreak: "text_end",
                  shouldInjectGroupIntro: false,
                  typingMode: "never",
                })
              : runActiveReplySteer({
                  followupRun: run,
                  opts: undefined,
                  providedReplyOperation: operation,
                  queueKey: key,
                  releaseAdmissionTicket: () => {},
                  replyOperationRunState: state,
                  resolvedQueue: { mode: "steer", debounceMs: 0 },
                  restartRecoverySourceTurnId: run.messageId,
                  runFollowup: followup,
                  sessionCtx: {},
                  sessionKey: key,
                  touchActiveSessionEntry: async () => {},
                  typing,
                  typingSignals: createTypingSignaler({
                    typing,
                    mode: "never",
                    isHeartbeat: false,
                  }),
                  toolAuthorityFingerprint:
                    mode === "legacy-receipt" ? "incoming-authority" : fingerprint,
                  ...(mode === "legacy-receipt"
                    ? { pendingInputAuthorityFingerprint: fingerprint }
                    : {}),
                })
          ).finally(() => {
            done = true;
          });
          void adoption.catch(() => undefined);
          try {
            await Promise.race([
              hold.entered,
              adoption.then(() => {
                throw new Error("adoption completed before the committed waiter gate");
              }),
            ]);
            const resolves = fixture.requests.filter(
              (request) => request.method === "question.resolve",
            );
            const wait = fixture.requests.find(
              (request) => request.method === "question.waitAnswer",
            );
            expect(resolves).toHaveLength(1);
            const receipt = await fixture.manager.waitAnswer(id, undefined, true);
            expect(receipt).toMatchObject({
              status: "answered",
              answers: { answers: { answer: [text] } },
            });
            if (mode === "legacy-receipt") {
              expect(resolves[0]?.params).not.toHaveProperty("resolutionId");
              expect(wait?.params).not.toHaveProperty("includeResolutionId");
              expect(receipt).not.toHaveProperty("resolutionId");
            } else {
              const resolveParams = resolves[0]?.params as { resolutionId?: string } | undefined;
              const resolutionId = resolveParams?.resolutionId;
              expect(resolutionId).toMatch(/^[a-f0-9]{32}$/);
              expect(receipt).toMatchObject({ resolutionId });
              expect(wait?.params).toMatchObject({ includeResolutionId: true });
            }
            expect(operation.phase).toBe("running");
            expect(operation.result).toBeNull();
            expect(cancel).not.toHaveBeenCalled();
            if (mode === "delayed-receipt") {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 1_200);
              });
              expect(done).toBe(false);
              expect(claim.isResolving()).toBe(true);
              expect(followup).not.toHaveBeenCalled();
              expect(cancel).not.toHaveBeenCalled();
            }
            if (confirmed || mode === "legacy-receipt") {
              hold.release();
            } else {
              hold.fail();
            }
            const result = await adoption;
            await answerOutcome;
            // Observe drainage without waiting for the replay a correct owner forbids.
            await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
            expect.soft(followup).not.toHaveBeenCalled();
            expect.soft(cancel).not.toHaveBeenCalled();
            expect.soft(operation.abortSignal.aborted).toBe(false);
            expect.soft(fixture.backingRun.signal.aborted).toBe(false);
            expect.soft(abandoned).not.toHaveBeenCalled();
            expect.soft(adopted).toHaveBeenCalledOnce();
            expect.soft(settled).toHaveBeenCalledOnce();
            expect(nativeSteer).not.toHaveBeenCalled();
            if (confirmed) {
              expect(result).toBe(entrypoint === "reply" ? undefined : "handled");
              expect(state.admission).toEqual({ status: "accepted", mode: "steer" });
            } else {
              expect.soft(result).toMatchObject({
                isError: true,
                text: expect.stringContaining("confirmation was lost"),
              });
              expect
                .soft(state.admission)
                .toEqual({ status: "skipped", reason: "question-response-indeterminate" });
            }
            if (entrypoint === "steer") {
              expect
                .soft(
                  enqueueFollowupRun(
                    key,
                    { ...run },
                    { mode: "followup", debounceMs: 0 },
                    "message-id",
                  ),
                )
                .toBe(false);
            }
          } finally {
            hold.release();
            await answerOutcome;
            await adoption.catch(() => undefined);
            claim.dispose();
            clearSessionQueues([key]);
          }
        }),
      );
      expect(replyRunRegistry.get(key)).toBeUndefined();
      expect(getExistingFollowupQueue(key)).toBeUndefined();
    },
  );
});

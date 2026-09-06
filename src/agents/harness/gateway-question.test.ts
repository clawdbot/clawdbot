import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createMessageInjectionAuthority } from "../../auto-reply/reply/message-injection-authority.js";
import {
  listSessionPendingInputs,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import {
  QuestionDispatchRefusedError,
  type AgentHarnessQuestionGatewayCall,
} from "./gateway-question-dispatch.js";
import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  claimPendingAgentQuestionAnswerFromCaller,
  registerPendingAgentQuestion,
  runAgentHarnessGatewayQuestion,
} from "./gateway-question.js";
import { withQuestionGateway } from "./gateway-question.test-support.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

const questions = [
  {
    id: "answer",
    header: "Answer",
    question: "What should happen?",
    isOther: true,
    options: [],
  },
] as const;

describe("gateway harness questions", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it.each([
    "committed",
    "failed",
    "uncommitted",
    "source-revoked",
    "question-replaced",
    "creator-closed",
    "unstaged",
  ] as const)("settles secret input only after current source persistence: %s", async (change) => {
    const sessionKey = "agent:main:secret-source-persistence";
    const attempt = {
      sessionId: "secret-source-session",
      sessionKey,
      runId: "secret-source-run",
      agentId: "main",
      config: {},
      sessionFile: "/tmp/secret-source-session.jsonl",
      workspaceDir: "/tmp/secret-source-workspace",
      provider: "openai",
      modelId: "gpt-test",
      messageProvider: "webchat",
      senderIsOwner: true,
    };
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    const controller = new AbortController();
    const source = new AbortController();
    const promptDelivered = createDeferred();
    const releasePersistence = createDeferred();
    const target = createTestUserTurnTranscriptTarget({
      sessionId: attempt.sessionId,
      sessionKey,
      storePath: path.join(tempDirs.make("secret-source-"), "sessions.sqlite"),
    });
    await replaceSessionEntry(target, { sessionId: attempt.sessionId, updatedAt: Date.now() });
    const sourceRecorder = createUserTurnTranscriptRecorder({
      target,
      input: { text: "example-input", idempotencyKey: "secret-source-input:user" },
      onPersistenceError: () => {},
    });
    if (change !== "unstaged") {
      expect(
        await sourceRecorder.stageApproved?.({
          runId: "secret-source-input",
          assertCurrent: () => source.signal.throwIfAborted(),
        }),
      ).toBe(true);
    }
    const stagedInputs = listSessionPendingInputs(target);
    expect(stagedInputs.total).toBe(change === "unstaged" ? 0 : 1);
    const gatewayCall = vi.fn<AgentHarnessQuestionGatewayCall>();
    const input = {
      sessionKey,
      questions: [
        { id: "answer", header: "Answer", question: "Enter the test input", isSecret: true },
      ],
      timeoutMs: 60_000,
      gatewayCall,
      delivery: {
        hostCapabilities: host.hostCapabilities,
        onBlockReply: async () => promptDelivered.resolve(),
      },
    };
    const ask = (signal: AbortSignal) =>
      withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext: host.admittedRunContext },
        { ...attempt, hostCapabilities: host.hostCapabilities },
        undefined,
        () => runAgentHarnessGatewayQuestion({ ...input, signal }),
      );
    const question = ask(controller.signal);
    let answered = false;
    void question.then(() => {
      answered = true;
    });
    const persistApproved = sourceRecorder.persistApproved.bind(sourceRecorder);
    const persist = vi
      .spyOn(sourceRecorder, "persistApproved")
      .mockImplementation(async (options) => {
        await releasePersistence.promise;
        if (change === "failed") {
          throw new Error("source persistence unavailable");
        }
        return change === "uncommitted" ? undefined : persistApproved(options);
      });
    const legacyPersist = vi.fn(async () => {});
    let claim: Promise<{ accepted: boolean } | { error: unknown }> | undefined;
    let replacement: ReturnType<typeof runAgentHarnessGatewayQuestion> | undefined;
    let replacementController: AbortController | undefined;
    try {
      await promptDelivered.promise;
      const claimParams = {
        sessionKey,
        text: "example-input",
        sourceRecorder,
        persist: legacyPersist,
        authority: {
          kind: "source-bound" as const,
          assertCurrent: () => source.signal.throwIfAborted(),
        },
      };
      claim = claimPendingAgentQuestionAnswer(claimParams).then(
        (accepted) => ({ accepted }),
        (error: unknown) => ({ error }),
      );
      if (change === "unstaged") {
        expect(await claim).toEqual({ accepted: true });
        await expect(question).resolves.toMatchObject({ status: "answered" });
        expect(persist).not.toHaveBeenCalled();
        expect(sourceRecorder.hasPersisted()).toBe(false);
        expect(legacyPersist).not.toHaveBeenCalled();
        expect(gatewayCall).not.toHaveBeenCalled();
        return;
      }
      expect(persist).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(answered).toBe(false);
      if (change === "source-revoked") {
        source.abort();
      } else if (change === "creator-closed") {
        host.closeHost();
      } else if (change === "question-replaced") {
        controller.abort();
        await expect(question).resolves.toEqual({ status: "cancelled" });
        replacementController = new AbortController();
        replacement = ask(replacementController.signal);
      }
      releasePersistence.resolve();
      if (change === "committed") {
        expect(await claim).toEqual({ accepted: true });
        expect(sourceRecorder.hasPersisted()).toBe(true);
        expect(listSessionPendingInputs(target)).toEqual({ total: 0, items: [] });
        expect(sourceRecorder.getAdmissionReceipt()?.entryId).toBe(stagedInputs.items[0]?.id);
        const messages = (await loadTranscriptEvents(target)).filter(
          (event) => asOptionalRecord(event)?.type === "message",
        );
        expect(messages).toEqual([
          expect.objectContaining({
            id: stagedInputs.items[0]?.id,
            message: expect.objectContaining({
              role: "user",
              content: "example-input",
              idempotencyKey: "secret-source-input:user",
            }),
          }),
        ]);
        await expect(question).resolves.toEqual({
          status: "answered",
          answers: { answers: { answer: ["example-input"] } },
        });
      } else {
        expect(await claim).toMatchObject({
          error: expect.any(change === "failed" ? Error : QuestionDispatchRefusedError),
        });
        if (
          change === "failed" ||
          change === "uncommitted" ||
          change === "source-revoked" ||
          change === "question-replaced"
        ) {
          await expect(
            claimPendingAgentQuestionAnswer({
              sessionKey,
              text: "replacement-input",
              persist: async () => {},
              authority: { kind: "source-bound", assertCurrent: () => {} },
            }),
          ).resolves.toBe(true);
          await expect(replacement ?? question).resolves.toEqual({
            status: "answered",
            answers: { answers: { answer: ["replacement-input"] } },
          });
        }
      }
      expect(legacyPersist).not.toHaveBeenCalled();
      expect(gatewayCall).not.toHaveBeenCalled();
    } finally {
      releasePersistence.resolve();
      controller.abort();
      replacementController?.abort();
      await claim;
      await question;
      await replacement;
      host.closeHost();
      host.closeAdmission();
    }
  });

  it("leaves an aborted caller without a pending question to ordinary admission", async () => {
    const source = new AbortController();
    source.abort();
    const persist = vi.fn();

    await expect(
      claimPendingAgentQuestionAnswerFromCaller({
        sessionKey: "agent:main:no-pending-question",
        text: "Continue",
        caller: {
          senderIsOwner: true,
          disableTools: false,
          traceAuthorized: false,
          messageProvider: "webchat",
        },
        assertSourceCurrent: () => source.signal.throwIfAborted(),
        persist,
      }),
    ).resolves.toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    { change: "open", cancel: false },
    { change: "closed", cancel: false },
    { change: "reassigned", cancel: false },
    { change: "closed", cancel: true },
    { change: "consumed", cancel: false },
  ] as const)(
    "rechecks $change source authority at real question dispatch (cancel=$cancel)",
    async ({ change, cancel }) => {
      await withQuestionGateway(async (fixture) => {
        const source = new AbortController();
        const originalOwner = {};
        let currentOwner = originalOwner;
        const assertCurrent = createMessageInjectionAuthority(
          () => !source.signal.aborted && currentOwner === originalOwner,
        );
        const authority = {
          kind: "source-bound" as const,
          assertCurrent: () => {
            assertCurrent();
            fixture.backingRun.signal.throwIfAborted();
          },
        };
        const questionId = "ask_66666666666666666666666666666666";
        const sessionKey = "agent:main:dispatch-authority";
        const promptDelivered = createDeferred();
        const run = runAgentHarnessGatewayQuestion({
          questionId,
          sessionKey,
          runId: "live-backing-run",
          questions,
          timeoutMs: 60_000,
          signal: fixture.backingRun.signal,
          delivery: { onBlockReply: async () => promptDelivered.resolve() },
        });
        await Promise.all([fixture.waitStarted, promptDelivered.promise]);
        const hello = fixture.holdNextHello();
        const attempt = cancel
          ? cancelPendingAgentQuestionForSession({
              sessionKey,
              resolvedBy: "image-reply",
              authority,
            })
          : claimPendingAgentQuestionAnswer({ sessionKey, text: "Old source answer", authority });
        const outcome = attempt.then(
          (accepted) => ({ accepted }),
          (error: unknown) => ({ error }),
        );
        await hello.entered;
        expect(fixture.manager.get(questionId)?.status).toBe("pending");
        expect(fixture.requests.filter((frame) => frame.method === "question.resolve")).toEqual([]);
        if (change === "closed") {
          source.abort();
        } else if (change === "reassigned") {
          currentOwner = {};
        } else if (change === "consumed") {
          // Closure after the canonical transition must not reopen an accepted
          // answer for steering replay, even before its RPC response arrives.
          fixture.onResolved(() => source.abort());
        }
        hello.release();
        const result = await outcome;
        expect(fixture.backingRun.signal.aborted).toBe(false);
        const revokedBeforeDispatch = change === "closed" || change === "reassigned";
        if (revokedBeforeDispatch) {
          expect
            .soft(fixture.requests.filter((frame) => frame.method === "question.resolve"))
            .toEqual([]);
          expect.soft(fixture.manager.get(questionId)?.status).toBe("pending");
          expect.soft(result).toHaveProperty("error");
          // Keep the same question and backing run: a rejected old source must
          // release its local reservation so a later valid input can answer.
          const later = await claimPendingAgentQuestionAnswer({
            sessionKey,
            text: "Current source answer",
            authority: { kind: "source-bound", assertCurrent: () => {} },
          });
          expect.soft(later).toBe(true);
          expect.soft(await run).toEqual({
            status: "answered",
            answers: { answers: { answer: ["Current source answer"] } },
          });
        } else {
          expect(result).toEqual({ accepted: true });
          expect(await run).toEqual({
            status: "answered",
            answers: { answers: { answer: ["Old source answer"] } },
          });
          expect(
            fixture.requests.filter((frame) => frame.method === "question.resolve"),
          ).toHaveLength(1);
        }
      });
    },
  );

  it("does not request a gateway question when the session reservation conflicts", async () => {
    const gatewayCall = vi.fn<AgentHarnessQuestionGatewayCall>();
    const reservation = registerPendingAgentQuestion({
      questionId: "ask_00000000000000000000000000000000",
      sessionKey: "agent:main:conflict",
      questions,
      gatewayCall,
    });

    await expect(
      runAgentHarnessGatewayQuestion({
        questions,
        sessionKey: "agent:main:conflict",
        timeoutMs: 60_000,
        gatewayCall,
        delivery: { onBlockReply: vi.fn() },
      }),
    ).rejects.toThrow("session already has a pending agent input request");
    expect(gatewayCall).not.toHaveBeenCalled();
    reservation.dispose();
  });

  it("fails a pending claim closed when disposed before registration attaches", async () => {
    const claim = registerPendingAgentQuestion({
      questionId: "ask_00000000000000000000000000000000",
      sessionKey: "agent:main:dispose-before-attach",
      questions,
      gatewayCall: vi.fn<AgentHarnessQuestionGatewayCall>(),
    });
    const answer = claimPendingAgentQuestionAnswer({
      sessionKey: "agent:main:dispose-before-attach",
      text: "Continue",
    });

    claim.dispose();

    await expect(answer).resolves.toBe(false);
  });

  it("reserves the session and suppresses a prompt cancelled during registration", async () => {
    const registration = createDeferred<{ id: string }>();
    const calls: Array<{ method: string; params: unknown }> = [];
    let resolveCount = 0;
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
      calls.push({ method, params });
      if (method === "question.request") {
        return await registration.promise;
      }
      if (method === "question.resolve") {
        resolveCount += 1;
        if (resolveCount === 1) {
          throw Object.assign(new Error("not registered yet"), {
            name: "GatewayClientRequestError",
            details: { reason: "QUESTION_NOT_FOUND" },
          });
        }
        return { status: "cancelled" };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    };
    const onBlockReply = vi.fn();
    const run = runAgentHarnessGatewayQuestion({
      questions,
      sessionKey: "agent:main:registering",
      timeoutMs: 60_000,
      gatewayCall,
      delivery: { onBlockReply },
      questionId: "ask_1234567890abcdef1234567890abcdef",
    });

    await expect(
      cancelPendingAgentQuestionForSession({
        sessionKey: "agent:main:registering",
        resolvedBy: "image-reply",
      }),
    ).resolves.toBe(true);
    registration.resolve({ id: "ask_1234567890abcdef1234567890abcdef" });

    await expect(run).resolves.toEqual({ status: "cancelled" });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(calls.filter((entry) => entry.method === "question.resolve")).toHaveLength(2);
    expect(calls.some((entry) => entry.method === "question.waitAnswer")).toBe(false);
  });

  it("observes an early wait rejection without delivering a stale prompt", async () => {
    const waitError = new Error("gateway disconnected");
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
      if (method === "question.request") {
        expect(params).toMatchObject({ runId: "run-delivery" });
        return { id: (params as { id: string }).id };
      }
      if (method === "question.waitAnswer") {
        throw waitError;
      }
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    };
    const onBlockReply = vi.fn();
    const run = runAgentHarnessGatewayQuestion({
      questions,
      sessionKey: "agent:main:delivery",
      runId: "run-delivery",
      timeoutMs: 60_000,
      gatewayCall,
      delivery: { onBlockReply },
      questionId: "ask_abcdef1234567890abcdef1234567890",
    });
    await expect(run).rejects.toBe(waitError);
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("returns an answer that wins a registration cancellation race", async () => {
    const registration = createDeferred<{ id: string }>();
    const answers = { answers: { answer: ["Continue"] } };
    let resolveCount = 0;
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method) => {
      if (method === "question.request") {
        return await registration.promise;
      }
      if (method === "question.resolve") {
        resolveCount += 1;
        throw Object.assign(new Error(resolveCount === 1 ? "not registered" : "already answered"), {
          name: "GatewayClientRequestError",
          details: {
            reason: resolveCount === 1 ? "QUESTION_NOT_FOUND" : "QUESTION_ALREADY_TERMINAL",
          },
        });
      }
      if (method === "question.waitAnswer") {
        return { status: "answered", answers };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    };
    const onBlockReply = vi.fn();
    const run = runAgentHarnessGatewayQuestion({
      questions,
      sessionKey: "agent:main:registration-answer",
      timeoutMs: 60_000,
      gatewayCall,
      delivery: { onBlockReply },
      questionId: "ask_11111111111111111111111111111111",
    });

    await expect(
      cancelPendingAgentQuestionForSession({
        sessionKey: "agent:main:registration-answer",
        resolvedBy: "image-reply",
      }),
    ).resolves.toBe(true);
    registration.resolve({ id: "ask_11111111111111111111111111111111" });

    await expect(run).resolves.toEqual({ status: "answered", answers });
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("returns an answer recovered after the request response is lost", async () => {
    const answers = { answers: { answer: ["Continue"] } };
    const requestError = new Error("request response lost");
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method) => {
      if (method === "question.request") {
        throw requestError;
      }
      if (method === "question.resolve") {
        throw Object.assign(new Error("already answered"), {
          name: "GatewayClientRequestError",
          details: { reason: "QUESTION_ALREADY_TERMINAL" },
        });
      }
      if (method === "question.waitAnswer") {
        return { status: "answered", answers };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    };

    await expect(
      runAgentHarnessGatewayQuestion({
        questions,
        sessionKey: "agent:main:lost-request-response",
        timeoutMs: 60_000,
        gatewayCall,
        delivery: { onBlockReply: vi.fn() },
        questionId: "ask_22222222222222222222222222222222",
      }),
    ).resolves.toEqual({ status: "answered", answers });
  });

  it("accepts a plain-text reply waiting for gateway registration", async () => {
    const registration = createDeferred<{ id: string }>();
    const answer = createDeferred<{
      status: "answered";
      answers: { answers: Record<string, string[]> };
    }>();
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
      if (method === "question.request") {
        return await registration.promise;
      }
      if (method === "question.waitAnswer") {
        return await answer.promise;
      }
      if (method === "question.resolve") {
        const resolvedAnswers = (params as { answers?: { answers: Record<string, string[]> } })
          .answers;
        if (!resolvedAnswers) {
          return { status: "cancelled" };
        }
        const result = { status: "answered" as const, answers: resolvedAnswers };
        answer.resolve(result);
        return result;
      }
      throw new Error(`unexpected gateway method: ${method}`);
    };
    const onBlockReply = vi.fn();
    const run = runAgentHarnessGatewayQuestion({
      questions,
      sessionKey: "agent:main:buffered-reply",
      timeoutMs: 60_000,
      gatewayCall,
      delivery: { onBlockReply },
      questionId: "ask_33333333333333333333333333333333",
    });

    // The claim settles only after registration commits so a failed request
    // cannot swallow the reply.
    const claim = claimPendingAgentQuestionAnswer({
      sessionKey: "agent:main:buffered-reply",
      text: "Continue",
    });
    registration.resolve({ id: "ask_33333333333333333333333333333333" });
    await expect(claim).resolves.toBe(true);

    await expect(run).resolves.toEqual({
      status: "answered",
      answers: { answers: { answer: ["Continue"] } },
    });
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("releases a claimed reply when gateway registration fails", async () => {
    const registration = createDeferred<{ id: string }>();
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method) => {
      if (method === "question.request") {
        return await registration.promise;
      }
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    };
    const run = runAgentHarnessGatewayQuestion({
      questions,
      sessionKey: "agent:main:failed-registration",
      timeoutMs: 60_000,
      gatewayCall,
      delivery: { onBlockReply: vi.fn() },
      questionId: "ask_44444444444444444444444444444444",
    });

    const claim = claimPendingAgentQuestionAnswer({
      sessionKey: "agent:main:failed-registration",
      text: "Continue",
    });
    registration.reject(new Error("gateway unavailable"));
    await expect(claim).resolves.toBe(false);
    await expect(run).rejects.toThrow("gateway unavailable");
  });

  it("accepts a later text answer after cancellation fails", async () => {
    const answer = createDeferred<{
      status: "answered";
      answers: { answers: Record<string, string[]> };
    }>();
    let cancelAttempts = 0;
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: (params as { id: string }).id };
      }
      if (method === "question.waitAnswer") {
        return await answer.promise;
      }
      if (method === "question.resolve") {
        const resolvedAnswers = (params as { answers?: { answers: Record<string, string[]> } })
          .answers;
        if (!resolvedAnswers) {
          cancelAttempts += 1;
          throw new Error("temporary gateway failure");
        }
        const result = { status: "answered" as const, answers: resolvedAnswers };
        answer.resolve(result);
        return result;
      }
      throw new Error(`unexpected gateway method: ${method}`);
    };
    const onBlockReply = vi.fn();
    const run = runAgentHarnessGatewayQuestion({
      questions,
      sessionKey: "agent:main:cancel-retry",
      timeoutMs: 60_000,
      gatewayCall,
      delivery: { onBlockReply },
      questionId: "ask_44444444444444444444444444444444",
    });
    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledOnce());
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        deliveryIntentId: "block-reply:v1:agent-question:ask_44444444444444444444444444444444",
      }),
    );

    await expect(
      cancelPendingAgentQuestionForSession({
        sessionKey: "agent:main:cancel-retry",
        resolvedBy: "image-reply",
      }),
    ).rejects.toThrow("temporary gateway failure");
    await expect(
      claimPendingAgentQuestionAnswer({
        sessionKey: "agent:main:cancel-retry",
        text: "Continue",
      }),
    ).resolves.toBe(true);

    await expect(run).resolves.toEqual({
      status: "answered",
      answers: { answers: { answer: ["Continue"] } },
    });
    expect(cancelAttempts).toBe(1);
  });

  it("returns a gateway answer without waiting for stalled prompt delivery", async () => {
    const answer = createDeferred<{
      status: "answered";
      answers: { answers: Record<string, string[]> };
    }>();
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: (params as { id: string }).id };
      }
      if (method === "question.waitAnswer") {
        return await answer.promise;
      }
      if (method === "question.resolve") {
        const answers = (params as { answers?: { answers: Record<string, string[]> } }).answers;
        if (answers) {
          answer.resolve({ status: "answered", answers });
          return { status: "answered", answers };
        }
        return { status: "cancelled" };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    };
    let deliverySignal: AbortSignal | undefined;
    const onBlockReply = vi.fn(
      async (_payload, context?: { abortSignal?: AbortSignal }) =>
        await new Promise<void>(() => {
          deliverySignal = context?.abortSignal;
        }),
    );
    const run = runAgentHarnessGatewayQuestion({
      questions,
      sessionKey: "agent:main:stalled-delivery",
      timeoutMs: 60_000,
      gatewayCall,
      delivery: { onBlockReply },
      questionId: "ask_0123456789abcdef0123456789abcdef",
    });
    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledOnce());
    await expect(
      claimPendingAgentQuestionAnswer({
        sessionKey: "agent:main:stalled-delivery",
        text: "Continue",
      }),
    ).resolves.toBe(true);
    const answers = { answers: { answer: ["Continue"] } };

    await expect(run).resolves.toEqual({ status: "answered", answers });
    expect(deliverySignal?.aborted).toBe(true);
  });

  it("does not deliver a prompt for an already-terminal gateway question", async () => {
    const answers = { answers: { answer: ["Continue"] } };
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: (params as { id: string }).id };
      }
      if (method === "question.waitAnswer") {
        return { status: "answered", answers };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    };
    const onBlockReply = vi.fn();

    await expect(
      runAgentHarnessGatewayQuestion({
        questions,
        sessionKey: "agent:main:already-terminal",
        timeoutMs: 60_000,
        gatewayCall,
        delivery: { onBlockReply },
        questionId: "ask_55555555555555555555555555555555",
      }),
    ).resolves.toEqual({ status: "answered", answers });
    expect(onBlockReply).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  registerPendingAgentQuestion,
  runAgentHarnessGatewayQuestion,
  type AgentHarnessQuestionGatewayCall,
} from "./gateway-question.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    ).rejects.toThrow("session already has a pending gateway question");
    expect(gatewayCall).not.toHaveBeenCalled();
    reservation.dispose();
  });

  it("fails a pending claim closed when disposed before registration attaches", async () => {
    const claim = registerPendingAgentQuestion({
      questionId: "ask_00000000000000000000000000000000",
      sessionKey: "agent:main:dispose-before-attach",
      questions,
      gatewayCall: vi.fn(),
    });
    const answer = claimPendingAgentQuestionAnswer({
      sessionKey: "agent:main:dispose-before-attach",
      text: "Continue",
    });

    claim.dispose();

    await expect(answer).resolves.toBe(false);
  });

  it("reserves the session and suppresses a prompt cancelled during registration", async () => {
    const registration = deferred<{ id: string }>();
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
      timeoutMs: 60_000,
      gatewayCall,
      delivery: { onBlockReply },
      questionId: "ask_abcdef1234567890abcdef1234567890",
    });
    await expect(run).rejects.toBe(waitError);
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("returns an answer that wins a registration cancellation race", async () => {
    const registration = deferred<{ id: string }>();
    const answers = { answers: { answer: { answers: ["Continue"] } } };
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
    const answers = { answers: { answer: { answers: ["Continue"] } } };
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

  it("buffers a plain-text reply while gateway registration is pending", async () => {
    const registration = deferred<{ id: string }>();
    const answer = deferred<{
      status: "answered";
      answers: { answers: Record<string, { answers: string[] }> };
    }>();
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
      if (method === "question.request") {
        return await registration.promise;
      }
      if (method === "question.waitAnswer") {
        return await answer.promise;
      }
      if (method === "question.resolve") {
        const resolvedAnswers = (
          params as { answers?: { answers: Record<string, { answers: string[] }> } }
        ).answers;
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
      answers: { answers: { answer: { answers: ["Continue"] } } },
    });
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("releases a claimed reply when gateway registration fails", async () => {
    const registration = deferred<{ id: string }>();
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
    const answer = deferred<{
      status: "answered";
      answers: { answers: Record<string, { answers: string[] }> };
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
        const resolvedAnswers = (
          params as { answers?: { answers: Record<string, { answers: string[] }> } }
        ).answers;
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
      answers: { answers: { answer: { answers: ["Continue"] } } },
    });
    expect(cancelAttempts).toBe(1);
  });

  it("returns a gateway answer without waiting for stalled prompt delivery", async () => {
    const answer = deferred<{
      status: "answered";
      answers: { answers: Record<string, { answers: string[] }> };
    }>();
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: (params as { id: string }).id };
      }
      if (method === "question.waitAnswer") {
        return await answer.promise;
      }
      if (method === "question.resolve") {
        const answers = (params as { answers?: { answers: Record<string, { answers: string[] }> } })
          .answers;
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
    const answers = { answers: { answer: { answers: ["Continue"] } } };

    await expect(run).resolves.toEqual({ status: "answered", answers });
    expect(deliverySignal?.aborted).toBe(true);
  });

  it("does not deliver a prompt for an already-terminal gateway question", async () => {
    const answers = { answers: { answer: { answers: ["Continue"] } } };
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

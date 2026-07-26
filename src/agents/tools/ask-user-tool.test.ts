import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt.queue-message.js";
import {
  cancelAskUserPromptDelivery,
  createAskUserTool,
  isAskUserPromptPending,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
  settleAskUserPromptDelivery,
  waitForAskUserPromptReady,
} from "./ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./ask-user-tool.test-support.js";

type GatewayCall = NonNullable<Parameters<typeof createAskUserTool>[0]["gatewayCall"]>;

const validArgs = {
  questions: [
    {
      id: "deploy_target",
      header: "Deployment target",
      question: "Where should this deploy?",
      options: [
        { label: "Staging (Recommended)", description: "Safer default" },
        { label: "Production" },
      ],
    },
  ],
};

function gatewayStub(
  implementation: (
    method: string,
    opts: Record<string, unknown>,
    params: Record<string, unknown>,
    extra?: { signal?: AbortSignal },
  ) => Promise<unknown>,
) {
  const mock = vi.fn(implementation);
  return { mock, call: mock as unknown as GatewayCall };
}

function requestedQuestionId(mock: ReturnType<typeof gatewayStub>["mock"]): string {
  const requestCall = mock.mock.calls.find(([method]) => method === "question.request");
  const questionId = requestCall?.[2].id;
  if (typeof questionId !== "string") {
    throw new Error("question.request did not include an id");
  }
  return questionId;
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
});

describe("ask_user normalization", () => {
  it("normalizes headers, forces free text, and clamps timeout", () => {
    const normalized = normalizeAskUserParams({ ...validArgs, timeoutSeconds: 5 });

    expect(normalized.timeoutSeconds).toBe(30);
    expect(normalized.questions[0]).toMatchObject({
      questionId: "deploy_target",
      header: "Deployment t",
      isOther: true,
    });
    expect(normalizeAskUserParams({ ...validArgs, timeoutSeconds: 9_999 }).timeoutSeconds).toBe(
      3_600,
    );
    expect(Value.Check(createAskUserTool({}).parameters, validArgs)).toBe(true);
    expect(
      Value.Check(createAskUserTool({}).parameters, {
        questions: [{ ...validArgs.questions[0], isSecret: true }],
      }),
    ).toBe(false);
    expect(normalized.questions[0]).not.toHaveProperty("isSecret");
  });

  it.each([
    ["empty questions", { questions: [] }, "1 to 3 questions"],
    [
      "too many questions",
      { questions: Array.from({ length: 4 }, () => validArgs.questions[0]) },
      "1 to 3 questions",
    ],
    [
      "too few options",
      { questions: [{ ...validArgs.questions[0], options: [{ label: "Only" }] }] },
      "2 to 4 options",
    ],
    [
      "duplicate ids",
      { questions: [validArgs.questions[0], validArgs.questions[0]] },
      "duplicate question id 'deploy_target'",
    ],
    [
      "invalid id",
      { questions: [{ ...validArgs.questions[0], id: "Deploy Target" }] },
      "must be snake_case",
    ],
  ])("rejects %s", (_name, args, error) => {
    expect(() => normalizeAskUserParams(args)).toThrow(error);
  });
});

describe("ask_user prompt delivery", () => {
  it("uses the Gateway record when the executor has isolated runtime state", async () => {
    const questions = normalizeAskUserParams(validArgs).questions;
    const reservation = reserveAskUserPromptDelivery({
      toolCallId: "call-isolated-runtime",
      sessionKey: "agent:main:isolated-runtime",
      questions,
    });
    if (!reservation) {
      throw new Error("expected prompt reservation");
    }
    const gateway = gatewayStub(async (method, _opts, params) => {
      expect(method).toBe("question.list");
      expect(params).toEqual({});
      return { questions: [{ id: reservation.questionId, status: "pending" }] };
    });

    await expect(waitForAskUserPromptReady(reservation.questionId, gateway.call)).resolves.toEqual(
      questions,
    );
    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(true);
  });

  it("rejects prompt delivery after the Gateway question terminalizes", async () => {
    const questions = normalizeAskUserParams(validArgs).questions;
    const reservation = reserveAskUserPromptDelivery({
      toolCallId: "call-terminal-before-delivery",
      sessionKey: "agent:main:terminal-before-delivery",
      questions,
    });
    if (!reservation) {
      throw new Error("expected prompt reservation");
    }
    const gateway = gatewayStub(async () => ({
      questions: [{ id: reservation.questionId, status: "expired" }],
    }));

    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(false);
  });

  it("retries a transient Gateway revalidation failure before delivering", async () => {
    const questions = normalizeAskUserParams(validArgs).questions;
    const reservation = reserveAskUserPromptDelivery({
      toolCallId: "call-revalidation-failure",
      sessionKey: "agent:main:revalidation-failure",
      questions,
    });
    if (!reservation) {
      throw new Error("expected prompt reservation");
    }
    let attempts = 0;
    const gateway = gatewayStub(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary Gateway disconnect");
      }
      return { questions: [{ id: reservation.questionId, status: "pending" }] };
    });

    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(true);
    expect(attempts).toBe(2);
  });

  it("drops a prompt when local terminalization wins during Gateway revalidation", async () => {
    const questions = normalizeAskUserParams(validArgs).questions;
    const toolCallId = "call-revalidation-terminal";
    const sessionKey = "agent:main:revalidation-terminal";
    const reservation = reserveAskUserPromptDelivery({ toolCallId, sessionKey, questions });
    if (!reservation) {
      throw new Error("expected prompt reservation");
    }
    const gateway = gatewayStub(async () => {
      cancelAskUserPromptDelivery(toolCallId, sessionKey);
      return { questions: [{ id: reservation.questionId, status: "pending" }] };
    });

    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(false);
  });

  it("expires prompt revalidation while the Gateway lookup remains stalled", async () => {
    vi.useFakeTimers();
    try {
      const questions = normalizeAskUserParams(validArgs).questions;
      const reservation = reserveAskUserPromptDelivery({
        toolCallId: "call-revalidation-stalled",
        sessionKey: "agent:main:revalidation-stalled",
        questions,
        timeoutSeconds: 30,
      });
      if (!reservation) {
        throw new Error("expected prompt reservation");
      }
      const gateway = gatewayStub(async () => await new Promise(() => {}));

      const pending = isAskUserPromptPending(reservation.questionId, gateway.call);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares prompt readiness across bundled module instances", async () => {
    const runId = "run-split-module";
    const toolCallId = "call-split-module";
    const questions = normalizeAskUserParams(validArgs).questions;
    const reservation = reserveAskUserPromptDelivery({
      toolCallId,
      runId,
      sessionKey: "agent:main:subscriber-session",
      questions,
    });
    if (!reservation) {
      throw new Error("expected prompt reservation");
    }
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      throw new Error(`unexpected method ${method}`);
    });

    vi.resetModules();
    const isolatedModule = await import("./ask-user-tool.js");
    const pending = isolatedModule
      .createAskUserTool({
        runId,
        sessionKey: "agent:main:executor-session",
        gatewayCall: gateway.call,
      })
      .execute(toolCallId, validArgs);
    await vi.waitFor(() =>
      expect(gateway.mock.mock.calls.some(([method]) => method === "question.request")).toBe(true),
    );
    let readyQuestions: unknown;
    void waitForAskUserPromptReady(reservation.questionId).then((value) => {
      readyQuestions = value;
    });
    await vi.waitFor(() => expect(readyQuestions).toEqual(questions));

    settleAskUserPromptDelivery(reservation.questionId);
    finishWait?.({
      status: "answered",
      answers: { answers: { deploy_target: ["Production"] } },
    });
    await expect(pending).resolves.toMatchObject({ details: { status: "answered" } });
  });
});

describe("ask_user execution", () => {
  it("returns answered details plus readable answer lines", async () => {
    const answers = { answers: { deploy_target: ["Staging (Recommended)"] } };
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id, expiresAtMs: Date.now() + 30_000 };
      }
      if (method === "question.waitAnswer") {
        return { status: "answered", answers };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createAskUserTool({
      agentId: "main",
      sessionKey: "agent:main:main",
      gatewayCall: gateway.call,
    });

    const result = await tool.execute("call-answered", validArgs);
    const questionId = requestedQuestionId(gateway.mock);

    expect(result.details).toEqual({ status: "answered", answers });
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Deployment t: Staging (Recommended)"),
      }),
    ]);
    expect(gateway.mock).toHaveBeenNthCalledWith(
      1,
      "question.request",
      {},
      expect.objectContaining({
        id: questionId,
        agentId: "main",
        sessionKey: "agent:main:main",
        timeoutMs: 900_000,
      }),
      undefined,
    );
    expect(gateway.mock).toHaveBeenNthCalledWith(
      2,
      "question.waitAnswer",
      { timeoutMs: 910_000 },
      { id: questionId, timeoutMs: 900_000 },
      undefined,
    );
  });

  it.each([
    ["expired", "No answer arrived"],
    ["pending", "No answer arrived"],
    ["cancelled", "question was cancelled"],
  ] as const)("maps %s to no_answer", async (status, text) => {
    const gateway = gatewayStub(async (method, _opts, params) =>
      method === "question.request" ? { id: params.id } : { status },
    );
    const result = await createAskUserTool({
      sessionKey: `agent:main:${status}`,
      gatewayCall: gateway.call,
    }).execute(`call-${status}`, validArgs);
    const questionId = requestedQuestionId(gateway.mock);

    expect(result.details).toEqual({ status: "no_answer" });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(text) });
    if (status === "pending") {
      expect(gateway.mock).toHaveBeenCalledWith(
        "question.resolve",
        { timeoutMs: 10_000 },
        { id: questionId, cancel: true, resolvedBy: "wait-timeout" },
      );
    }
  });

  it("rejects a second pending question in the same session", async () => {
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      if (method === "question.resolve") {
        finishWait?.({ status: "cancelled" });
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createAskUserTool({
      sessionKey: "agent:main:serialized",
      gatewayCall: gateway.call,
    });
    const first = tool.execute("call-first", validArgs);
    await vi.waitFor(() => expect(finishWait).toBeTypeOf("function"));

    await expect(tool.execute("call-second", validArgs)).rejects.toThrow(
      "already has a pending question",
    );
    finishWait?.({ status: "cancelled" });
    await expect(first).resolves.toMatchObject({ details: { status: "no_answer" } });
  });

  it("cancels the gateway question when the run aborts", async () => {
    const controller = new AbortController();
    const gateway = gatewayStub(async (method, _opts, params, extra) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      return await new Promise((_resolve, reject) => {
        extra?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    const pending = createAskUserTool({
      sessionKey: "agent:main:abort",
      gatewayCall: gateway.call,
    }).execute("call-abort", validArgs, controller.signal);
    await vi.waitFor(() =>
      expect(gateway.mock.mock.calls.some((call) => call[0] === "question.waitAnswer")).toBe(true),
    );
    const questionId = requestedQuestionId(gateway.mock);

    controller.abort(new Error("stop"));

    await expect(pending).rejects.toThrow("aborted");
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.resolve",
      { timeoutMs: 10_000 },
      { id: questionId, cancel: true, resolvedBy: "run-abort" },
    );
  });

  it("aborts registration and still attempts gateway cancellation", async () => {
    const controller = new AbortController();
    const gateway = gatewayStub(async (method, _opts, _params, extra) => {
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      return await new Promise((_resolve, reject) => {
        extra?.signal?.addEventListener("abort", () => reject(new Error("registration aborted")), {
          once: true,
        });
      });
    });
    const pending = createAskUserTool({
      sessionKey: "agent:main:register-abort",
      gatewayCall: gateway.call,
    }).execute("call-register-abort", validArgs, controller.signal);
    await vi.waitFor(() =>
      expect(gateway.mock.mock.calls.some((call) => call[0] === "question.request")).toBe(true),
    );
    const questionId = requestedQuestionId(gateway.mock);

    controller.abort(new Error("stop"));

    await expect(pending).rejects.toThrow("registration aborted");
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.resolve",
      { timeoutMs: 10_000 },
      { id: questionId, cancel: true, resolvedBy: "run-abort" },
    );
  });

  it("does not activate prompt delivery when registration ignores an earlier abort", async () => {
    const sessionKey = "agent:main:late-registration-abort";
    const reservation = reserveAskUserPromptDelivery({
      toolCallId: "call-late-registration-abort",
      sessionKey,
      questions: normalizeAskUserParams(validArgs).questions,
    });
    if (!reservation) {
      throw new Error("expected prompt reservation");
    }
    let finishRegistration: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method) => {
      if (method === "question.request") {
        return await new Promise((resolve) => {
          finishRegistration = resolve;
        });
      }
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const controller = new AbortController();
    const pending = createAskUserTool({ sessionKey, gatewayCall: gateway.call }).execute(
      "call-late-registration-abort",
      validArgs,
      controller.signal,
    );
    await vi.waitFor(() => expect(finishRegistration).toBeTypeOf("function"));

    controller.abort(new Error("stop before registration completed"));
    finishRegistration?.({ id: reservation.questionId });

    await expect(pending).rejects.toThrow("stop before registration completed");
    expect(
      reserveAskUserPromptDelivery({
        toolCallId: "call-after-late-registration-abort",
        sessionKey,
        questions: normalizeAskUserParams(validArgs).questions,
      }),
    ).toBeDefined();
  });

  it("suppresses a stale prompt when an image arrives during registration", async () => {
    let finishRegistration: ((value: unknown) => void) | undefined;
    let resolveCount = 0;
    const gateway = gatewayStub(async (method) => {
      if (method === "question.request") {
        return await new Promise((resolve) => {
          finishRegistration = resolve;
        });
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
      throw new Error(`unexpected method ${method}`);
    });
    const sessionKey = "agent:main:register-image";
    const pending = createAskUserTool({ sessionKey, gatewayCall: gateway.call }).execute(
      "call-register-image",
      validArgs,
    );
    await vi.waitFor(() => expect(finishRegistration).toBeTypeOf("function"));
    const questionId = requestedQuestionId(gateway.mock);
    const steer = vi.fn(async () => undefined);
    const images = [{ type: "image" as const, data: "pixels", mimeType: "image/png" }];

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "Use this image",
      { isInboundUserMessage: true, images },
      sessionKey,
    );
    finishRegistration?.({ id: questionId });

    expect(steer).toHaveBeenCalledWith("Use this image", images);
    await expect(pending).resolves.toMatchObject({ details: { status: "no_answer" } });
    expect(
      gateway.mock.mock.calls.filter(([method]) => method === "question.resolve"),
    ).toHaveLength(2);
    expect(gateway.mock.mock.calls.some(([method]) => method === "question.waitAnswer")).toBe(
      false,
    );
  });

  it("best-effort cancels a deterministic id after an ambiguous registration failure", async () => {
    const sessionKey = "agent:main:registration-loss";
    const gateway = gatewayStub(async (method) => {
      if (method === "question.request") {
        throw new Error("connection lost after send");
      }
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(
      createAskUserTool({ sessionKey, gatewayCall: gateway.call }).execute(
        "call-registration-loss",
        validArgs,
      ),
    ).rejects.toThrow("connection lost after send");
    const questionId = requestedQuestionId(gateway.mock);
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.resolve",
      { timeoutMs: 10_000 },
      { id: questionId, cancel: true, resolvedBy: "registration-failed" },
    );
  });

  it("cancels instead of waiting when originating prompt delivery fails", async () => {
    const sessionKey = "agent:main:delivery-failure";
    const reservation = reserveAskUserPromptDelivery({
      toolCallId: "call-delivery-failure",
      sessionKey,
      questions: normalizeAskUserParams(validArgs).questions,
    });
    if (!reservation) {
      throw new Error("expected prompt reservation");
    }
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      if (method === "question.resolve") {
        finishWait?.({ status: "cancelled" });
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const pending = createAskUserTool({ sessionKey, gatewayCall: gateway.call }).execute(
      "call-delivery-failure",
      validArgs,
    );
    await vi.waitFor(() => expect(finishWait).toBeTypeOf("function"));

    settleAskUserPromptDelivery(reservation.questionId, new Error("channel unavailable"));

    await expect(pending).rejects.toThrow("ask_user prompt delivery failed");
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.resolve",
      { timeoutMs: 10_000 },
      { id: reservation.questionId, cancel: true, resolvedBy: "prompt-delivery-failed" },
    );
    expect(gateway.mock.mock.calls.some((call) => call[0] === "question.waitAnswer")).toBe(true);
  });

  it("preserves an answer that wins the prompt-failure cancellation race", async () => {
    const sessionKey = "agent:main:delivery-answer-race";
    const reservation = reserveAskUserPromptDelivery({
      toolCallId: "call-delivery-answer-race",
      sessionKey,
      questions: normalizeAskUserParams(validArgs).questions,
    });
    if (!reservation) {
      throw new Error("expected prompt reservation");
    }
    const answers = { answers: { deploy_target: ["Production"] } };
    let waitCalls = 0;
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        waitCalls += 1;
        if (waitCalls === 1) {
          return await new Promise<unknown>(() => {});
        }
        return { status: "answered", answers };
      }
      if (method === "question.resolve") {
        throw Object.assign(new Error("already answered"), {
          name: "GatewayClientRequestError",
          details: { reason: "QUESTION_ALREADY_TERMINAL" },
        });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const pending = createAskUserTool({ sessionKey, gatewayCall: gateway.call }).execute(
      "call-delivery-answer-race",
      validArgs,
    );
    await vi.waitFor(() => expect(waitCalls).toBe(1));

    settleAskUserPromptDelivery(reservation.questionId, new Error("channel unavailable"));

    await expect(pending).resolves.toMatchObject({ details: { status: "answered", answers } });
    expect(waitCalls).toBe(2);
  });

  it("aborts while prompt delivery is still pending", async () => {
    const sessionKey = "agent:main:delivery-abort";
    const reservation = reserveAskUserPromptDelivery({
      toolCallId: "call-delivery-abort",
      sessionKey,
      questions: normalizeAskUserParams(validArgs).questions,
    });
    if (!reservation) {
      throw new Error("expected prompt reservation");
    }
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _opts, params, extra) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve, reject) => {
          finishWait = resolve;
          extra?.signal?.addEventListener("abort", () => reject(new Error("wait aborted")), {
            once: true,
          });
        });
      }
      if (method === "question.resolve") {
        finishWait?.({ status: "cancelled" });
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const controller = new AbortController();
    const pending = createAskUserTool({ sessionKey, gatewayCall: gateway.call }).execute(
      "call-delivery-abort",
      validArgs,
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(gateway.mock.mock.calls.some((call) => call[0] === "question.request")).toBe(true),
    );

    controller.abort(new Error("stop during delivery"));

    await expect(pending).rejects.toThrow("stop during delivery");
    expect(
      reserveAskUserPromptDelivery({
        toolCallId: "call-after-delivery-abort",
        sessionKey,
        questions: normalizeAskUserParams(validArgs).questions,
      }),
    ).toBeDefined();
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.resolve",
      { timeoutMs: 10_000 },
      { id: reservation.questionId, cancel: true, resolvedBy: "run-abort" },
    );
  });

  it("claims unmatched plain text as free text without steering it into the run", async () => {
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      if (method === "question.resolve") {
        const answers = params.answers;
        finishWait?.({ status: "answered", answers });
        return { status: "answered", answers };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const pending = createAskUserTool({
      sessionKey: "agent:main:claim",
      gatewayCall: gateway.call,
    }).execute("call-claim", validArgs);
    await vi.waitFor(() => expect(finishWait).toBeTypeOf("function"));
    const questionId = requestedQuestionId(gateway.mock);
    const steer = vi.fn(async () => undefined);
    const activeSession = { steer, subscribe: vi.fn(() => () => undefined) };
    const persistApproved = vi.fn(async () => undefined);
    const recorder = { persistApproved } as unknown as UserTurnTranscriptRecorder;

    await steerActiveSessionWithOptionalDeliveryWait(
      activeSession,
      "A custom destination",
      {
        isInboundUserMessage: true,
        waitForTranscriptCommit: true,
        userTurnTranscriptRecorder: recorder,
      },
      "agent:main:claim",
    );

    expect(steer).not.toHaveBeenCalled();
    expect(persistApproved).toHaveBeenCalledOnce();
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.resolve",
      {},
      {
        id: questionId,
        answers: { answers: { deploy_target: ["A custom destination"] } },
        resolvedBy: "plain-text",
      },
    );
    await expect(pending).resolves.toMatchObject({ details: { status: "answered" } });
  });

  it.each([
    ["cancellation succeeds", false],
    ["cancellation fails", true],
  ])("keeps image replies on normal steering when %s", async (_name, cancelFails) => {
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      if (method === "question.resolve") {
        if ("cancel" in params) {
          if (cancelFails) {
            throw new Error("gateway unavailable");
          }
          finishWait?.({ status: "cancelled" });
          return { status: "cancelled" };
        }
        const result = { status: "answered", answers: params.answers };
        finishWait?.(result);
        return result;
      }
      throw new Error(`unexpected method ${method}`);
    });
    const suffix = cancelFails ? "image-cancel-failure" : "image-reply";
    const sessionKey = `agent:main:${suffix}`;
    const pending = createAskUserTool({ sessionKey, gatewayCall: gateway.call }).execute(
      `call-${suffix}`,
      validArgs,
    );
    await vi.waitFor(() => expect(finishWait).toBeTypeOf("function"));
    const questionId = requestedQuestionId(gateway.mock);
    const steer = vi.fn(async () => undefined);
    const images = [{ type: "image" as const, data: "pixels", mimeType: "image/png" }];

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "Use this image",
      { isInboundUserMessage: true, images },
      sessionKey,
    );

    expect(steer).toHaveBeenCalledWith("Use this image", images);
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.resolve",
      { timeoutMs: 10_000 },
      {
        id: questionId,
        cancel: true,
        resolvedBy: "image-reply",
      },
    );
    if (cancelFails) {
      const followUpSteer = vi.fn(async () => undefined);
      await steerActiveSessionWithOptionalDeliveryWait(
        { steer: followUpSteer, subscribe: vi.fn(() => () => undefined) },
        "Follow-up after image",
        { isInboundUserMessage: true },
        sessionKey,
      );
      expect(followUpSteer).not.toHaveBeenCalled();
    }
    await expect(pending).resolves.toMatchObject({
      details: { status: cancelFails ? "answered" : "no_answer" },
    });
  });

  it("confirms a committed plain-text answer after its resolve response is lost", async () => {
    let finishWait: ((value: unknown) => void) | undefined;
    let committedAnswers: unknown;
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        if (committedAnswers) {
          return { status: "answered", answers: committedAnswers };
        }
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      if (method === "question.resolve") {
        committedAnswers = params.answers;
        finishWait?.({ status: "answered", answers: committedAnswers });
        throw new Error("response lost after commit");
      }
      throw new Error(`unexpected method ${method}`);
    });
    const sessionKey = "agent:main:resolve-loss";
    const pending = createAskUserTool({ sessionKey, gatewayCall: gateway.call }).execute(
      "call-resolve-loss",
      validArgs,
    );
    await vi.waitFor(() => expect(finishWait).toBeTypeOf("function"));
    const steer = vi.fn(async () => undefined);
    const persistApproved = vi.fn(async () => undefined);

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "1",
      {
        isInboundUserMessage: true,
        userTurnTranscriptRecorder: { persistApproved } as unknown as UserTurnTranscriptRecorder,
      },
      sessionKey,
    );

    expect(steer).not.toHaveBeenCalled();
    expect(persistApproved).toHaveBeenCalledOnce();
    await expect(pending).resolves.toMatchObject({ details: { status: "answered" } });
  });

  it("falls back to normal steering when the gateway question is already terminal", async () => {
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      if (method === "question.resolve") {
        throw Object.assign(new Error("already answered"), {
          name: "GatewayClientRequestError",
          details: { reason: "QUESTION_ALREADY_TERMINAL" },
        });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const pending = createAskUserTool({
      sessionKey: "agent:main:terminal-race",
      gatewayCall: gateway.call,
    }).execute("call-terminal-race", validArgs);
    await vi.waitFor(() => expect(finishWait).toBeTypeOf("function"));
    const steer = vi.fn(async () => undefined);

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "Follow-up message",
      { isInboundUserMessage: true },
      "agent:main:terminal-race",
    );

    expect(steer).toHaveBeenCalledWith("Follow-up message", undefined);
    finishWait?.({ status: "cancelled" });
    await pending;
  });
});

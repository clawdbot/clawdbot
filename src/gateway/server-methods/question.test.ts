import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionManager } from "../question-manager.js";
import { createQuestionHandlers } from "./question.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

let manager: QuestionManager;
let broadcast: ReturnType<typeof vi.fn>;
let handlers: ReturnType<typeof createQuestionHandlers>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  manager = new QuestionManager();
  broadcast = vi.fn();
  handlers = createQuestionHandlers(manager);
});

afterEach(() => {
  manager.reset();
  vi.useRealTimers();
});

async function call(method: string, params: Record<string, unknown>) {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => calls.push(args);
  await handlers[method]?.({
    req: { type: "req", id: "request-1", method, params },
    params,
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: { broadcast } as unknown as GatewayRequestHandlerOptions["context"],
  });
  const response = calls[0];
  if (!response) {
    throw new Error(`expected ${method} response`);
  }
  return response;
}

const requestParams = {
  questions: [
    {
      id: "destination",
      header: "Longer than twelve",
      question: "Where next?",
      options: [],
      multiSelect: false,
      isOther: true,
      isSecret: false,
    },
  ],
  agentId: "main",
  sessionKey: "agent:main:main",
  timeoutMs: 100,
};

describe("question gateway methods", () => {
  it("requests normalized questions, then gets and lists them", async () => {
    const requested = await call("question.request", {
      ...requestParams,
      id: "client-question-id",
    });
    expect(requested[0]).toBe(true);
    const id = (requested[1] as { id: string }).id;
    expect(id).toBe("client-question-id");
    expect(broadcast).toHaveBeenCalledWith(
      "question.requested",
      expect.objectContaining({
        id,
        questions: [expect.objectContaining({ header: "Longer than " })],
        status: "pending",
      }),
    );

    expect(await call("question.get", { id })).toEqual([
      true,
      { question: expect.objectContaining({ id, status: "pending" }) },
      undefined,
    ]);
    expect(await call("question.list", {})).toEqual([
      true,
      { questions: [expect.objectContaining({ id })] },
      undefined,
    ]);
  });

  it("broadcasts answered and expired terminal states", async () => {
    const requested = await call("question.request", requestParams);
    const id = (requested[1] as { id: string }).id;
    const answers = { answers: { destination: { answers: ["Home"] } } };

    expect(await call("question.resolve", { id, answers, resolvedBy: "control-ui" })).toEqual([
      true,
      { status: "answered", answers },
      undefined,
    ]);
    expect(broadcast).toHaveBeenCalledWith("question.resolved", {
      id,
      status: "answered",
      answers,
    });

    const expiring = await call("question.request", { ...requestParams, timeoutMs: 10 });
    const expiringId = (expiring[1] as { id: string }).id;
    await vi.advanceTimersByTimeAsync(10);
    expect(broadcast).toHaveBeenCalledWith("question.resolved", {
      id: expiringId,
      status: "expired",
    });
  });

  it("rejects duplicate ids and one-option questions at the request boundary", async () => {
    const duplicate = await call("question.request", {
      questions: [requestParams.questions[0], requestParams.questions[0]],
    });
    expect(duplicate[0]).toBe(false);
    expect((duplicate[2] as { message: string }).message).toContain("duplicate question id");

    const oneOption = await call("question.request", {
      questions: [{ ...requestParams.questions[0], options: [{ label: "Only" }] }],
    });
    expect(oneOption[0]).toBe(false);
    expect((oneOption[2] as { message: string }).message).toContain("2 to 4 options");

    const clientId = "duplicate-client-id";
    expect((await call("question.request", { ...requestParams, id: clientId }))[0]).toBe(true);
    const reusedId = await call("question.request", { ...requestParams, id: clientId });
    expect(reusedId[0]).toBe(false);
    expect(reusedId[2]).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "QUESTION_ID_IN_USE" },
    });
  });

  it("rejects secret questions and duplicate normalized option labels", async () => {
    const secret = await call("question.request", {
      ...requestParams,
      questions: [{ ...requestParams.questions[0], isSecret: true }],
    });
    expect(secret[0]).toBe(false);
    expect((secret[2] as { message: string }).message).toContain(
      "question 'destination': secret questions are not supported yet",
    );

    const duplicateLabels = await call("question.request", {
      ...requestParams,
      questions: [
        {
          ...requestParams.questions[0],
          options: [{ label: " Deploy " }, { label: "deploy" }],
        },
      ],
    });
    expect(duplicateLabels[0]).toBe(false);
    expect((duplicateLabels[2] as { message: string }).message).toContain(
      "question 'destination' has duplicate option label",
    );
  });

  it("returns INVALID_REQUEST for answers that violate the stored question", async () => {
    const requested = await call("question.request", {
      ...requestParams,
      questions: [
        {
          ...requestParams.questions[0],
          options: [{ label: "Home" }, { label: "Office" }],
          isOther: false,
        },
      ],
    });
    const id = (requested[1] as { id: string }).id;

    const resolved = await call("question.resolve", {
      id,
      answers: { answers: { destination: { answers: ["Somewhere else"] } } },
    });

    expect(resolved[0]).toBe(false);
    expect(resolved[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("question 'destination'"),
      details: { reason: "QUESTION_INVALID_ANSWER" },
    });
    expect(manager.get(id)?.status).toBe("pending");
  });
});

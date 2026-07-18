// Control UI tests cover operator question parsing and lifecycle state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  cancelQuestionPrompt,
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
  submitQuestionPrompt,
} from "./question-prompt.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;
type QuestionPromptState = ReturnType<typeof createQuestionPromptState>;

const states: QuestionPromptState[] = [];

function createState(onChange = vi.fn()) {
  const state = createQuestionPromptState(onChange);
  states.push(state);
  return state;
}

function requestedPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "question-1",
    questions: [
      {
        id: "format",
        header: "Format",
        question: "Which format should I use?",
        options: [{ label: "Compact", description: "Keep it brief" }, { label: "Detailed" }],
        isOther: true,
      },
    ],
    agentId: "main",
    sessionKey: "agent:main:main",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
    ...overrides,
  };
}

function questionNotFoundError() {
  return Object.assign(new Error("question was not found"), {
    name: "GatewayClientRequestError",
    details: { reason: "QUESTION_NOT_FOUND" },
  });
}

afterEach(() => {
  for (const state of states.splice(0)) {
    disposeQuestionPromptState(state);
  }
  vi.useRealTimers();
});

describe("question event parsing", () => {
  it("round-trips requested and resolved event payloads", () => {
    const state = createState();
    expect(
      handleQuestionPromptEvent(state, {
        event: "question.requested",
        payload: requestedPayload(),
      }),
    ).toBe(true);
    expect(state.prompts.get("question-1")).toMatchObject({
      id: "question-1",
      sessionKey: "agent:main:main",
      status: "pending",
      questions: [{ id: "format", options: [{ label: "Compact" }, { label: "Detailed" }] }],
    });
    expect(
      handleQuestionPromptEvent(state, {
        event: "question.resolved",
        payload: {
          id: "question-1",
          status: "answered",
          answers: { answers: { format: { answers: ["Compact"] } } },
        },
      }),
    ).toBe(true);
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answers: { answers: { format: { answers: ["Compact"] } } },
    });
  });

  it("rejects malformed records and answer maps", () => {
    const state = createState();
    expect(
      handleQuestionPromptEvent(state, {
        event: "question.requested",
        payload: requestedPayload({ id: "" }),
      }),
    ).toBe(false);
    expect(
      handleQuestionPromptEvent(state, {
        event: "question.requested",
        payload: requestedPayload({
          questions: [{ id: "Bad ID", header: "Bad", question: "Bad?", options: [] }],
        }),
      }),
    ).toBe(false);
    expect(
      handleQuestionPromptEvent(state, {
        event: "question.resolved",
        payload: {
          id: "question-1",
          status: "answered",
          answers: { answers: { format: { answers: "Compact" } } },
        },
      }),
    ).toBe(false);
  });
});

describe("question prompt state", () => {
  it.each(["cancelled", "expired"] as const)("transitions requested to %s", (status) => {
    const state = createState();
    expect(
      handleQuestionPromptEvent(state, {
        event: "question.requested",
        payload: requestedPayload(),
      }),
    ).toBe(true);

    handleQuestionPromptEvent(state, {
      event: "question.resolved",
      payload: { id: "question-1", status },
    });

    expect(state.prompts.get("question-1")?.status).toBe(status);
  });

  it("marks answers from another surface", () => {
    const state = createState();
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });
    handleQuestionPromptEvent(state, {
      event: "question.resolved",
      payload: {
        id: "question-1",
        status: "answered",
        answers: { answers: { format: { answers: ["Detailed"] } } },
      },
    });

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      answers: { answers: { format: { answers: ["Detailed"] } } },
    });
  });

  it("marks a locally submitted answer as local when its broadcast arrives", async () => {
    let releaseRequest: () => void = () => {};
    const request = vi.fn<RequestFn>(
      () =>
        new Promise((resolve) => {
          releaseRequest = () => resolve({ status: "answered" });
        }),
    );
    const state = createState();
    setQuestionPromptClient(state, { request });
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    const submitting = submitQuestionPrompt(state, "question-1", { format: ["Compact"] });
    handleQuestionPromptEvent(state, {
      event: "question.resolved",
      payload: {
        id: "question-1",
        status: "answered",
        answers: { answers: { format: { answers: ["Compact"] } } },
      },
    });
    releaseRequest();
    await submitting;

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: false,
      localResolutionConfirmed: true,
      submitting: false,
    });
  });

  it("marks a concurrent winning answer from another surface", async () => {
    let rejectRequest: (error: Error) => void = () => {};
    const request = vi.fn<RequestFn>(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const state = createState();
    setQuestionPromptClient(state, { request });
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    const submitting = submitQuestionPrompt(state, "question-1", { format: ["Compact"] });
    handleQuestionPromptEvent(state, {
      event: "question.resolved",
      payload: {
        id: "question-1",
        status: "answered",
        answers: { answers: { format: { answers: ["Detailed"] } } },
      },
    });
    rejectRequest(new Error("question already resolved"));
    await submitting;

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      localResolutionConfirmed: false,
      submitting: false,
      answers: { answers: { format: { answers: ["Detailed"] } } },
    });
  });

  it("keeps local provenance when the accepted resolve response is lost", async () => {
    let rejectRequest: (error: Error) => void = () => {};
    const request = vi.fn<RequestFn>(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const state = createState();
    setQuestionPromptClient(state, { request });
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    const submitting = submitQuestionPrompt(state, "question-1", { format: ["Compact"] });
    handleQuestionPromptEvent(state, {
      event: "question.resolved",
      payload: {
        id: "question-1",
        status: "answered",
        answers: { answers: { format: { answers: ["Compact"] } } },
      },
    });
    rejectRequest(new Error("connection closed"));
    await submitting;

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: false,
      submitting: false,
      answers: { answers: { format: { answers: ["Compact"] } } },
    });
  });

  it("expires pending cards locally when their countdown ends", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const state = createState();
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload({ expiresAtMs: Date.now() + 1_000 }),
    });

    vi.advanceTimersByTime(1_000);

    expect(state.prompts.get("question-1")?.status).toBe("expired");
  });

  it("re-enables a prompt with a non-destructive resolve error", async () => {
    const request = vi.fn<RequestFn>(async () => {
      throw new Error("gateway unavailable");
    });
    const state = createState();
    setQuestionPromptClient(state, { request });
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    await submitQuestionPrompt(state, "question-1", { format: ["Compact"] });

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "pending",
      submitting: false,
      error: "gateway unavailable",
    });
  });

  it("surfaces a retryable error when submission happens while disconnected", async () => {
    const state = createState();
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    await submitQuestionPrompt(state, "question-1", { format: ["Compact"] });

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "pending",
      submitting: false,
      error: "Not connected. Try again after reconnecting.",
    });
  });
});

describe("question RPC helpers", () => {
  it("sends option labels, free text, and multi-select arrays in the frozen answer shape", async () => {
    const request = vi.fn<RequestFn>(async () => ({}));
    const state = createState();
    setQuestionPromptClient(state, { request });
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    await submitQuestionPrompt(state, "question-1", {
      format: ["Compact"],
      destination: ["My own target"],
      extras: ["Tests", "Docs"],
    });

    expect(request).toHaveBeenCalledWith("question.resolve", {
      id: "question-1",
      answers: {
        answers: {
          format: { answers: ["Compact"] },
          destination: { answers: ["My own target"] },
          extras: { answers: ["Tests", "Docs"] },
        },
      },
    });
  });

  it("cancels a pending question when the docked panel is skipped", async () => {
    const request = vi.fn<RequestFn>(async () => ({}));
    const state = createState();
    setQuestionPromptClient(state, { request });
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    await cancelQuestionPrompt(state, "question-1");

    expect(request).toHaveBeenCalledWith("question.resolve", {
      id: "question-1",
      cancel: true,
    });
  });
});

describe("refreshPendingQuestions", () => {
  it("hydrates pending questions after connect", async () => {
    const request = vi.fn<RequestFn>(async () => ({ questions: [requestedPayload()] }));
    const state = createState();
    const client = { request };
    setQuestionPromptClient(state, client);

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("pending"));

    expect(request).toHaveBeenCalledWith("question.list", {});
    expect(state.prompts.get("question-1")?.status).toBe("pending");
  });

  it("retries transient hydration failures while the client remains current", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const request = vi.fn<RequestFn>(async () => {
      attempts += 1;
      if (attempts < 5) {
        throw new Error("gateway unavailable");
      }
      return { questions: [requestedPayload()] };
    });
    const state = createState();
    const client = { request };
    setQuestionPromptClient(state, client);

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(request).toHaveBeenCalledTimes(5);
    expect(state.prompts.get("question-1")?.status).toBe("pending");
  });

  it("preserves a resolution received while reconnect refresh is in flight", async () => {
    let finishList: (value: unknown) => void = () => {};
    const request = vi.fn<RequestFn>(
      () =>
        new Promise((resolve) => {
          finishList = resolve;
        }),
    );
    const state = createState();
    const client = { request };
    setQuestionPromptClient(state, client);
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    refreshPendingQuestionsWithRetry(state, client);
    handleQuestionPromptEvent(state, {
      event: "question.resolved",
      payload: {
        id: "question-1",
        status: "answered",
        answers: { answers: { format: { answers: ["Detailed"] } } },
      },
    });
    finishList({ questions: [requestedPayload()] });
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));

    expect(state.prompts.get("question-1")?.status).toBe("answered");
  });

  it("retains a resolution that arrives before reconnect hydration", async () => {
    let finishList: (value: unknown) => void = () => {};
    const request = vi.fn<RequestFn>((method) =>
      method === "question.list"
        ? new Promise((resolve) => {
            finishList = resolve;
          })
        : Promise.resolve({
            question: requestedPayload({
              status: "answered",
              answers: { answers: { format: { answers: ["Detailed"] } } },
            }),
          }),
    );
    const state = createState();
    const client = { request };
    setQuestionPromptClient(state, client);

    refreshPendingQuestionsWithRetry(state, client);
    handleQuestionPromptEvent(state, {
      event: "question.resolved",
      payload: {
        id: "question-1",
        status: "answered",
        answers: { answers: { format: { answers: ["Detailed"] } } },
      },
    });
    finishList({ questions: [] });
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));

    expect(request).toHaveBeenCalledWith("question.get", { id: "question-1" });
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      answers: { answers: { format: { answers: ["Detailed"] } } },
    });
    expect(state.unmatchedResolutions.size).toBe(0);
  });

  it("recovers a terminal answer missed during disconnect", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      return {
        question: requestedPayload({
          status: "answered",
          answers: { answers: { format: { answers: ["Detailed"] } } },
        }),
      };
    });
    const state = createState();
    const client = { request };
    setQuestionPromptClient(state, client);
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));

    expect(request).toHaveBeenCalledWith("question.get", { id: "question-1" });
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      answers: { answers: { format: { answers: ["Detailed"] } } },
    });
  });

  it("keeps a missing pending question recoverable after question.get fails", async () => {
    let getAttempts = 0;
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      getAttempts += 1;
      if (getAttempts === 1) {
        throw new Error("gateway unavailable");
      }
      return {
        question: requestedPayload({
          status: "answered",
          answers: { answers: { format: { answers: ["Detailed"] } } },
        }),
      };
    });
    const state = createState();
    const client = { request };
    setQuestionPromptClient(state, client);
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(state.prompts.get("question-1")?.status).toBe("pending");

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      answers: { answers: { format: { answers: ["Detailed"] } } },
    });
  });

  it("terminalizes a missing pending question after authoritative not-found", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      throw questionNotFoundError();
    });
    const state = createState();
    const client = { request };
    setQuestionPromptClient(state, client);
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      locallyExpired: false,
      submitting: false,
      error: null,
    });
  });

  it("reconciles a locally expired prompt with the authoritative record", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const request = vi.fn<RequestFn>(async (method) =>
      method === "question.list"
        ? { questions: [] }
        : {
            question: requestedPayload({
              status: "answered",
              answers: { answers: { format: { answers: ["Detailed"] } } },
            }),
          },
    );
    const state = createState();
    const client = { request };
    setQuestionPromptClient(state, client);
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload({ expiresAtMs: Date.now() + 1_000 }),
    });
    vi.advanceTimersByTime(1_000);
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "expired",
      locallyExpired: true,
    });

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      locallyExpired: false,
      answeredElsewhere: true,
      answers: { answers: { format: { answers: ["Detailed"] } } },
    });
  });

  it("applies a question.get answer when the local timer expires in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    let finishGet: (value: unknown) => void = () => {};
    const request = vi.fn<RequestFn>((method) => {
      if (method === "question.list") {
        return Promise.resolve({ questions: [] });
      }
      return new Promise((resolve) => {
        finishGet = resolve;
      });
    });
    const state = createState();
    const client = { request };
    setQuestionPromptClient(state, client);
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload({ expiresAtMs: Date.now() + 1_000 }),
    });

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("question.get", { id: "question-1" }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.prompts.get("question-1")?.locallyExpired).toBe(true);
    finishGet({
      question: requestedPayload({
        status: "answered",
        answers: { answers: { format: { answers: ["Detailed"] } } },
      }),
    });

    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      locallyExpired: false,
      answeredElsewhere: true,
    });
  });

  it("reconciles local expiry that occurs while question.list is in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    let finishList: (value: unknown) => void = () => {};
    const request = vi.fn<RequestFn>((method) => {
      if (method === "question.list") {
        return new Promise((resolve) => {
          finishList = resolve;
        });
      }
      return Promise.resolve({
        question: requestedPayload({
          status: "answered",
          answers: { answers: { format: { answers: ["Detailed"] } } },
        }),
      });
    });
    const state = createState();
    const client = { request };
    setQuestionPromptClient(state, client);
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload({ expiresAtMs: Date.now() + 1_000 }),
    });

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(1_000);
    finishList({ questions: [] });

    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));
    expect(request).toHaveBeenCalledWith("question.get", { id: "question-1" });
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      locallyExpired: false,
      answeredElsewhere: true,
    });
  });

  it("publishes listed questions before older reconciliation finishes", async () => {
    let finishGet: (value: unknown) => void = () => {};
    const request = vi.fn<RequestFn>((method) => {
      if (method === "question.list") {
        return Promise.resolve({
          questions: [requestedPayload({ id: "question-2", createdAtMs: 2_000 })],
        });
      }
      return new Promise((resolve) => {
        finishGet = resolve;
      });
    });
    const onChange = vi.fn();
    const state = createState(onChange);
    const client = { request };
    setQuestionPromptClient(state, client);
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: requestedPayload(),
    });
    onChange.mockClear();

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("question.get", { id: "question-1" }),
    );

    expect(state.prompts.get("question-2")?.status).toBe("pending");
    expect(onChange).toHaveBeenCalled();

    finishGet({ question: requestedPayload({ status: "cancelled" }) });
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("cancelled"));
  });
});

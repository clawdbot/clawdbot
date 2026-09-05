// @vitest-environment node
// Control UI tests cover operator question parsing and lifecycle state.
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
import type { QuestionAnswers, QuestionResolveResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
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

type RequestFn = (
  method: string,
  params?: unknown,
  options?: GatewayProtocolRequestOptions,
) => Promise<unknown>;
type QuestionPromptState = ReturnType<typeof createQuestionPromptState>;

const states: QuestionPromptState[] = [];
const defaultRequestDeadline = { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS };

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
        questionId: "format",
        header: "Format",
        question: "Which format should I use?",
        options: [{ label: "Compact", description: "Keep it brief" }, { label: "Detailed" }],
        isOther: true,
      },
    ],
    agentId: "main",
    sessionKey: "agent:main:main",
    runId: "run-question",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
    ...overrides,
  };
}

function requestQuestion(state: QuestionPromptState, overrides: Record<string, unknown> = {}) {
  return handleQuestionPromptEvent(state, {
    event: "question.requested",
    payload: requestedPayload(overrides),
  });
}

function recordQuestionResolution(state: QuestionPromptState, payload: unknown) {
  return handleQuestionPromptEvent(state, { event: "question.resolved", payload });
}

function resolvedQuestion(params?: unknown): QuestionResolveResult {
  const request = params as { answers?: QuestionAnswers; cancel?: true } | undefined;
  return request?.cancel
    ? { status: "cancelled" }
    : {
        status: "answered",
        answers: request?.answers ?? { answers: { format: ["Compact"] } },
      };
}

function createQuestionResolver() {
  return vi.fn<RequestFn>(async (_method, params) => resolvedQuestion(params));
}

function createConnectedState(request: RequestFn | { request: RequestFn }, payload?: unknown) {
  const state = createState();
  const client = typeof request === "function" ? { request } : request;
  setQuestionPromptClient(state, client);
  if (payload !== undefined) {
    handleQuestionPromptEvent(state, { event: "question.requested", payload });
  }
  return { state, client };
}

function questionNotFoundError() {
  return new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "question was not found",
    details: { reason: "QUESTION_NOT_FOUND" },
  });
}

function rejectAfterRequestDeadline(options?: GatewayProtocolRequestOptions): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timeoutMs = options?.timeoutMs;
    if (typeof timeoutMs === "number") {
      setTimeout(
        () => reject(new Error(`gateway request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }
  });
}

function createDeferredQuestionRequest() {
  let finishRequest: (value: unknown) => void = () => {};
  let failRequest: (error: Error) => void = () => {};
  const request = vi.fn<RequestFn>(
    () =>
      new Promise((resolve, reject) => {
        finishRequest = resolve;
        failRequest = reject;
      }),
  );
  return {
    request,
    resolve: () => finishRequest(resolvedQuestion(request.mock.calls.at(-1)?.[1])),
    reject: () => failRequest(new Error("stale gateway unavailable")),
  };
}

const questionResolutionCases = [
  {
    action: "answer",
    resolve: (state: QuestionPromptState) =>
      submitQuestionPrompt(state, "question-1", { format: ["Compact"] }),
  },
  {
    action: "cancel",
    resolve: (state: QuestionPromptState) => cancelQuestionPrompt(state, "question-1"),
  },
] as const;

afterEach(() => {
  for (const state of states.splice(0)) {
    disposeQuestionPromptState(state);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("question event parsing", () => {
  it("round-trips requested and resolved event payloads", () => {
    const state = createState();
    expect(requestQuestion(state)).toBe(true);
    expect(state.prompts.get("question-1")).toMatchObject({
      id: "question-1",
      runId: "run-question",
      sessionKey: "agent:main:main",
      status: "pending",
      questions: [{ questionId: "format", options: [{ label: "Compact" }, { label: "Detailed" }] }],
    });
    expect(
      recordQuestionResolution(state, {
        id: "question-1",
        status: "answered",
        answers: { answers: { format: ["Compact"] } },
      }),
    ).toBe(true);
    expect(state.prompts.get("question-1")).toMatchObject({
      runId: "run-question",
      status: "answered",
      answers: { answers: { format: ["Compact"] } },
    });
  });

  it("uses the protocol run id for a background-session question", () => {
    const state = createState();
    expect(
      handleQuestionPromptEvent(state, {
        event: "question.requested",
        payload: requestedPayload({
          sessionKey: "agent:main:background",
          runId: "run-background",
        }),
      }),
    ).toBe(true);
    expect(state.prompts.get("question-1")).toMatchObject({
      sessionKey: "agent:main:background",
      runId: "run-background",
      status: "pending",
    });
  });

  it("rejects malformed records and answer maps", () => {
    const state = createState();
    expect(requestQuestion(state, { id: "" })).toBe(false);
    expect(
      handleQuestionPromptEvent(state, {
        event: "question.requested",
        payload: requestedPayload({
          questions: [{ questionId: "Bad ID", header: "Bad", question: "Bad?", options: [] }],
        }),
      }),
    ).toBe(false);
    expect(
      recordQuestionResolution(state, {
        id: "question-1",
        status: "answered",
        answers: { answers: { format: "Compact" } },
      }),
    ).toBe(false);
  });
});

describe("question prompt state", () => {
  it.each(["cancelled", "expired"] as const)("transitions requested to %s", (status) => {
    const state = createState();
    expect(requestQuestion(state)).toBe(true);

    recordQuestionResolution(state, { id: "question-1", status });

    expect(state.prompts.get("question-1")?.status).toBe(status);
  });

  it("marks answers from another surface", () => {
    const state = createState();
    requestQuestion(state);
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: { answers: { format: ["Detailed"] } },
    });

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      answers: { answers: { format: ["Detailed"] } },
    });
  });

  it("marks a locally submitted answer as local when its broadcast arrives", async () => {
    let releaseRequest: () => void = () => {};
    const request = vi.fn<RequestFn>(
      () =>
        new Promise((resolve) => {
          releaseRequest = () => resolve(resolvedQuestion());
        }),
    );
    const { state } = createConnectedState(request, requestedPayload());

    const submitting = submitQuestionPrompt(state, "question-1", { format: ["Compact"] });
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: { answers: { format: ["Compact"] } },
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
    const { state } = createConnectedState(request, requestedPayload());

    const submitting = submitQuestionPrompt(state, "question-1", { format: ["Compact"] });
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: { answers: { format: ["Detailed"] } },
    });
    rejectRequest(new Error("question already resolved"));
    await submitting;

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      localResolutionConfirmed: false,
      submitting: false,
      answers: { answers: { format: ["Detailed"] } },
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
    const { state } = createConnectedState(request, requestedPayload());

    const submitting = submitQuestionPrompt(state, "question-1", { format: ["Compact"] });
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: { answers: { format: ["Compact"] } },
    });
    rejectRequest(new Error("connection closed"));
    await submitting;

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: false,
      submitting: false,
      answers: { answers: { format: ["Compact"] } },
    });
  });

  it("expires pending cards locally when their countdown ends", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const state = createState();
    requestQuestion(state, { expiresAtMs: Date.now() + 1_000 });

    vi.advanceTimersByTime(1_000);

    expect(state.prompts.get("question-1")?.status).toBe("expired");
  });

  it("re-enables a prompt with a non-destructive resolve error", async () => {
    const request = vi.fn<RequestFn>(async () => {
      throw new Error("gateway unavailable");
    });
    const { state } = createConnectedState(request, requestedPayload());

    await submitQuestionPrompt(state, "question-1", { format: ["Compact"] });

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "pending",
      submitting: false,
      error: "gateway unavailable",
    });
  });

  it("surfaces a retryable error when submission happens while disconnected", async () => {
    const translate = vi
      .spyOn(i18n, "t")
      .mockImplementation((key) =>
        key === "chat.questions.disconnected" ? "Localized reconnect guidance" : key,
      );
    const state = createState();
    requestQuestion(state);

    await submitQuestionPrompt(state, "question-1", { format: ["Compact"] });

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "pending",
      submitting: false,
      error: "Localized reconnect guidance",
    });
    expect(translate).toHaveBeenCalledWith("chat.questions.disconnected", undefined);
  });
});

describe("question RPC helpers", () => {
  it("sends option labels, free text, and multi-select arrays in the frozen answer shape", async () => {
    const request = createQuestionResolver();
    const questions = [
      ...requestedPayload().questions,
      {
        questionId: "destination",
        header: "Destination",
        question: "Where should I send it?",
        options: [],
        isOther: true,
      },
      {
        questionId: "extras",
        header: "Extras",
        question: "What should I include?",
        options: [{ label: "Tests" }, { label: "Docs" }],
        multiSelect: true,
      },
    ];
    const { state } = createConnectedState(request, requestedPayload({ questions }));

    await submitQuestionPrompt(state, "question-1", {
      format: ["Compact"],
      destination: ["My own target"],
      extras: ["Tests", "Docs"],
    });

    expect(request).toHaveBeenCalledWith(
      "question.resolve",
      {
        id: "question-1",
        answers: {
          answers: {
            format: ["Compact"],
            destination: ["My own target"],
            extras: ["Tests", "Docs"],
          },
        },
      },
      defaultRequestDeadline,
    );
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      localResolutionConfirmed: true,
      answeredElsewhere: false,
      submitting: false,
    });
  });

  it("cancels a pending question when the docked panel is skipped", async () => {
    const request = createQuestionResolver();
    const { state } = createConnectedState(request, requestedPayload());

    await cancelQuestionPrompt(state, "question-1");

    expect(request).toHaveBeenCalledWith(
      "question.resolve",
      { id: "question-1", cancel: true },
      defaultRequestDeadline,
    );
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "cancelled",
      localResolutionConfirmed: true,
      submitting: false,
    });
  });

  it.each([{}, { status: "answered" }, { status: "cancelled" }])(
    "keeps an invalid successful answer response retryable: %o",
    async (result) => {
      const request = vi.fn<RequestFn>(async () => result);
      const { state } = createConnectedState(request, requestedPayload());

      await submitQuestionPrompt(state, "question-1", { format: ["Compact"] });

      expect(state.prompts.get("question-1")).toMatchObject({
        status: "pending",
        submitting: false,
        error: "invalid question.resolve response",
      });
    },
  );

  it.each(questionResolutionCases)(
    "re-enables a stalled $action when its gateway request reaches the owner deadline",
    async ({ resolve }) => {
      vi.useFakeTimers();
      const request = vi.fn<RequestFn>((_method, _params, options) =>
        rejectAfterRequestDeadline(options),
      );
      const { state } = createConnectedState(request, requestedPayload());

      const pending = resolve(state);
      expect(state.prompts.get("question-1")?.submitting).toBe(true);
      await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);

      expect(state.prompts.get("question-1")).toMatchObject({
        status: "pending",
        submitting: false,
        error: `gateway request timed out after ${DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS}ms`,
      });
      await pending;
    },
  );

  it.each(questionResolutionCases)(
    "clips a $action request to the remaining question lifetime",
    async ({ resolve }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
      const request = createQuestionResolver();
      const { state } = createConnectedState(
        request,
        requestedPayload({ expiresAtMs: Date.now() + 1_250 }),
      );

      await resolve(state);

      expect(request).toHaveBeenCalledWith("question.resolve", expect.any(Object), {
        timeoutMs: 1_250,
      });
    },
  );
});

describe("question resolution connection ownership", () => {
  it.each(questionResolutionCases)(
    "ignores an old $action success after the gateway client changes",
    async ({ resolve }) => {
      const stale = createDeferredQuestionRequest();
      const current = createDeferredQuestionRequest();
      const { state } = createConnectedState(stale.request, requestedPayload());

      const staleResolution = resolve(state);
      setQuestionPromptClient(state, { request: current.request });
      expect(state.prompts.has("question-1")).toBe(false);
      requestQuestion(state);

      const currentResolution = resolve(state);
      stale.resolve();
      await staleResolution;

      expect(state.prompts.get("question-1")).toMatchObject({
        status: "pending",
        submitting: true,
        localResolutionConfirmed: false,
        error: null,
      });

      current.resolve();
      await currentResolution;
      expect(state.prompts.get("question-1")?.localResolutionConfirmed).toBe(true);
    },
  );

  it.each(questionResolutionCases)(
    "ignores an old $action error after the gateway client changes",
    async ({ resolve }) => {
      const stale = createDeferredQuestionRequest();
      const current = createDeferredQuestionRequest();
      const { state } = createConnectedState(stale.request, requestedPayload());

      const staleResolution = resolve(state);
      setQuestionPromptClient(state, { request: current.request });
      expect(state.prompts.has("question-1")).toBe(false);
      requestQuestion(state);

      const currentResolution = resolve(state);
      stale.reject();
      await staleResolution;

      expect(state.prompts.get("question-1")).toMatchObject({
        status: "pending",
        submitting: true,
        localResolutionConfirmed: false,
        error: null,
      });

      current.resolve();
      await currentResolution;
      expect(state.prompts.get("question-1")?.localResolutionConfirmed).toBe(true);
    },
  );

  it.each(questionResolutionCases)(
    "rejects an old $action when the same gateway transport reconnects",
    async ({ resolve }) => {
      const stale = createDeferredQuestionRequest();
      const current = createDeferredQuestionRequest();
      let requestCount = 0;
      const client = {
        request: vi.fn<RequestFn>((method, params) => {
          requestCount += 1;
          return requestCount === 1
            ? stale.request(method, params)
            : current.request(method, params);
        }),
      };
      const { state } = createConnectedState(client, requestedPayload());

      const staleResolution = resolve(state);
      // Socket closure rejects its pending requests before reconnect callbacks.
      stale.reject();
      setQuestionPromptClient(state, null);
      expect(state.prompts.get("question-1")?.submitting).toBe(false);
      setQuestionPromptClient(state, client);

      const currentResolution = resolve(state);
      await staleResolution;

      expect(state.prompts.get("question-1")).toMatchObject({
        status: "pending",
        submitting: true,
        localResolutionConfirmed: false,
        error: null,
      });

      current.resolve();
      await currentResolution;
      expect(state.prompts.get("question-1")?.localResolutionConfirmed).toBe(true);
    },
  );

  it.each(questionResolutionCases)(
    "keeps a current $action after same-connection prompt hydration",
    async ({ action, resolve }) => {
      const pending = createDeferredQuestionRequest();
      const request = vi.fn<RequestFn>((method, params) =>
        method === "question.list"
          ? Promise.resolve({ questions: [requestedPayload()] })
          : pending.request(method, params),
      );
      const { state, client } = createConnectedState(request, requestedPayload());

      const resolution = resolve(state);
      const original = state.prompts.get("question-1");
      refreshPendingQuestionsWithRetry(state, client);
      await waitForFast(() => expect(state.prompts.get("question-1")).not.toBe(original));

      pending.resolve();
      await resolution;

      expect(state.prompts.get("question-1")).toMatchObject({
        status: action === "answer" ? "answered" : "cancelled",
        localResolutionConfirmed: true,
        submitting: false,
        error: null,
      });
    },
  );

  it.each(["pending", "answered", "cancelled", "expired"] as const)(
    "does not carry a %s question into a replacement gateway",
    (status) => {
      const firstClient = { request: createQuestionResolver() };
      const secondClient = { request: createQuestionResolver() };
      const { state } = createConnectedState(firstClient, requestedPayload());
      if (status !== "pending") {
        handleQuestionPromptEvent(state, {
          event: "question.resolved",
          payload:
            status === "answered"
              ? {
                  id: "question-1",
                  status,
                  answers: { answers: { format: ["Detailed"] } },
                }
              : { id: "question-1", status },
        });
      }
      recordQuestionResolution(state, { id: "unmatched-first-gateway", status: "cancelled" });
      setQuestionPromptClient(state, null);

      setQuestionPromptClient(state, secondClient);

      expect(state.prompts.size).toBe(0);
      expect(state.unmatchedResolutions.size).toBe(0);
    },
  );

  it("preserves authoritative question records when the same gateway reconnects", () => {
    const client = { request: createQuestionResolver() };
    const { state } = createConnectedState(client, requestedPayload());
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: { answers: { format: ["Detailed"] } },
    });
    recordQuestionResolution(state, { id: "unmatched-same-gateway", status: "cancelled" });

    setQuestionPromptClient(state, null);
    setQuestionPromptClient(state, client);

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answers: { answers: { format: ["Detailed"] } },
    });
    expect(state.unmatchedResolutions.has("unmatched-same-gateway")).toBe(true);
  });
});

describe("refreshPendingQuestions", () => {
  it("hydrates pending questions after connect", async () => {
    const request = vi.fn<RequestFn>(async () => ({ questions: [requestedPayload()] }));
    const { state, client } = createConnectedState(request);

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("pending"));

    expect(request).toHaveBeenCalledWith("question.list", {}, defaultRequestDeadline);
    expect(state.prompts.get("question-1")?.status).toBe("pending");
  });

  it("retries question hydration when the gateway leaves question.list unresolved", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const request = vi.fn<RequestFn>((_method, _params, options) => {
      attempts += 1;
      return attempts === 1
        ? rejectAfterRequestDeadline(options)
        : Promise.resolve({ questions: [requestedPayload()] });
    });
    const { state, client } = createConnectedState(request);

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request).toHaveBeenCalledTimes(2);
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
    const { state, client } = createConnectedState(request);

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
    const { state, client } = createConnectedState(request, requestedPayload());

    refreshPendingQuestionsWithRetry(state, client);
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: { answers: { format: ["Detailed"] } },
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
              answers: { answers: { format: ["Detailed"] } },
            }),
          }),
    );
    const { state, client } = createConnectedState(request);

    refreshPendingQuestionsWithRetry(state, client);
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: { answers: { format: ["Detailed"] } },
    });
    finishList({ questions: [] });
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));

    expect(request).toHaveBeenCalledWith(
      "question.get",
      { id: "question-1" },
      defaultRequestDeadline,
    );
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      answers: { answers: { format: ["Detailed"] } },
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
          answers: { answers: { format: ["Detailed"] } },
        }),
      };
    });
    const { state, client } = createConnectedState(request, requestedPayload());

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));

    expect(request).toHaveBeenCalledWith(
      "question.get",
      { id: "question-1" },
      defaultRequestDeadline,
    );
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      answers: { answers: { format: ["Detailed"] } },
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
          answers: { answers: { format: ["Detailed"] } },
        }),
      };
    });
    const { state, client } = createConnectedState(request, requestedPayload());

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(state.prompts.get("question-1")?.status).toBe("pending");

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      answers: { answers: { format: ["Detailed"] } },
    });
  });

  it("terminalizes a missing pending question with an unknown outcome after not-found", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      throw questionNotFoundError();
    });
    const { state, client } = createConnectedState(request, requestedPayload());

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("unavailable"));

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "unavailable",
      answeredElsewhere: false,
      locallyExpired: false,
      submitting: false,
      error: null,
    });
  });

  it("stops retrying an unmatched resolution after its gateway tombstone ages out", async () => {
    vi.useFakeTimers();
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      throw questionNotFoundError();
    });
    const { state, client } = createConnectedState(request);
    recordQuestionResolution(state, { id: "forgotten-question", status: "cancelled" });
    setQuestionPromptClient(state, null);
    await vi.advanceTimersByTimeAsync(15_000);
    setQuestionPromptClient(state, client);

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.unmatchedResolutions.has("forgotten-question")).toBe(false);
    expect(state.refreshRetryTimer).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps an unmatched resolution recoverable after a transient question.get failure", async () => {
    vi.useFakeTimers();
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
          answers: { answers: { format: ["Detailed"] } },
        }),
      };
    });
    const { state, client } = createConnectedState(request);
    recordQuestionResolution(state, {
      id: "question-1",
      status: "answered",
      answers: { answers: { format: ["Detailed"] } },
    });

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.unmatchedResolutions.has("question-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      answeredElsewhere: true,
      answers: { answers: { format: ["Detailed"] } },
    });
    expect(state.unmatchedResolutions.size).toBe(0);
  });

  it("recovers a sibling question when another question.get never responds", async () => {
    vi.useFakeTimers();
    const request = vi.fn<RequestFn>((method, params, options) => {
      if (method === "question.list") {
        return Promise.resolve({ questions: [] });
      }
      if ((params as { id: string }).id === "question-1") {
        return rejectAfterRequestDeadline(options);
      }
      return Promise.resolve({
        question: requestedPayload({
          id: "question-2",
          status: "answered",
          answers: { answers: { format: ["Detailed"] } },
        }),
      });
    });
    const { state, client } = createConnectedState(request);
    for (const id of ["question-1", "question-2"]) {
      requestQuestion(state, { id });
    }

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.prompts.get("question-2")).toMatchObject({
      status: "answered",
      answers: { answers: { format: ["Detailed"] } },
    });
    expect(state.prompts.get("question-1")?.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
    expect(state.prompts.get("question-1")?.status).toBe("pending");
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
              answers: { answers: { format: ["Detailed"] } },
            }),
          },
    );
    const { state, client } = createConnectedState(
      request,
      requestedPayload({ expiresAtMs: Date.now() + 1_000 }),
    );
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
      answers: { answers: { format: ["Detailed"] } },
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
    const { state, client } = createConnectedState(
      request,
      requestedPayload({ expiresAtMs: Date.now() + 1_000 }),
    );

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "question.get",
        { id: "question-1" },
        defaultRequestDeadline,
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.prompts.get("question-1")?.locallyExpired).toBe(true);
    finishGet({
      question: requestedPayload({
        status: "answered",
        answers: { answers: { format: ["Detailed"] } },
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
          answers: { answers: { format: ["Detailed"] } },
        }),
      });
    });
    const { state, client } = createConnectedState(
      request,
      requestedPayload({ expiresAtMs: Date.now() + 1_000 }),
    );

    refreshPendingQuestionsWithRetry(state, client);
    await vi.advanceTimersByTimeAsync(1_000);
    finishList({ questions: [] });

    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("answered"));
    expect(request).toHaveBeenCalledWith(
      "question.get",
      { id: "question-1" },
      defaultRequestDeadline,
    );
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
    requestQuestion(state);
    onChange.mockClear();

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "question.get",
        { id: "question-1" },
        defaultRequestDeadline,
      ),
    );

    expect(state.prompts.get("question-2")?.status).toBe("pending");
    expect(onChange).toHaveBeenCalled();

    finishGet({ question: requestedPayload({ status: "cancelled" }) });
    await waitForFast(() => expect(state.prompts.get("question-1")?.status).toBe("cancelled"));
  });
});

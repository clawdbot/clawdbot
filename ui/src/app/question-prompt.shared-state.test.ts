// @vitest-environment node
// One Gateway client owns question outcomes across chat panes and sidebar projections.
import type { QuestionResolveResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelQuestionPrompt,
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
  submitQuestionPrompt,
} from "./question-prompt.ts";

type QuestionState = ReturnType<typeof createQuestionPromptState>;
type QuestionClient = {
  request: (method: string, params?: unknown) => Promise<unknown>;
};

const states: QuestionState[] = [];

function createQuestionClient(): QuestionClient {
  return {
    request: vi.fn(async (_method: string, params?: unknown) =>
      (params as { cancel?: boolean } | undefined)?.cancel
        ? ({ status: "cancelled" } satisfies QuestionResolveResult)
        : ({
            status: "answered",
            answers: { answers: { format: ["Compact"] } },
          } satisfies QuestionResolveResult),
    ),
  };
}

function requestQuestion(
  state: QuestionState,
  id = "question-1",
  expiresAtMs = Date.now() + 60_000,
): void {
  handleQuestionPromptEvent(state, {
    event: "question.requested",
    payload: {
      id,
      agentId: "main",
      sessionKey: "agent:main:main",
      questions: [
        {
          questionId: "format",
          header: "Format",
          question: "Which format should I use?",
          options: [{ label: "Compact" }, { label: "Detailed" }],
        },
      ],
      createdAtMs: 1_000,
      expiresAtMs,
      status: "pending",
    },
  });
}

function connectQuestionState(
  client: QuestionClient,
  onChange: () => void = vi.fn(),
  expiresAtMs?: number,
): QuestionState {
  const state = createQuestionPromptState(onChange);
  states.push(state);
  setQuestionPromptClient(state, client);
  requestQuestion(state, "question-1", expiresAtMs);
  return state;
}

const resolutionCases = [
  {
    action: "answer",
    status: "answered",
    resolve: (state: QuestionState) =>
      submitQuestionPrompt(state, "question-1", { format: [" Compact "] }),
  },
  {
    action: "cancellation",
    status: "cancelled",
    resolve: (state: QuestionState) => cancelQuestionPrompt(state, "question-1"),
  },
] as const;

afterEach(() => {
  for (const state of states.splice(0)) {
    disposeQuestionPromptState(state);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Gateway-client question outcome ownership", () => {
  it.each(resolutionCases)(
    "publishes an authoritative $action to every same-client pane and sidebar owner",
    async ({ resolve, status }) => {
      const client = createQuestionClient();
      const submitter = connectQuestionState(client);
      const splitPane = connectQuestionState(client);
      const sidebar = connectQuestionState(client);

      await resolve(submitter);

      expect(submitter.prompts.get("question-1")).toMatchObject({
        status,
        localResolutionConfirmed: true,
        answeredElsewhere: false,
        submitting: false,
      });
      for (const peer of [splitPane, sidebar]) {
        expect(peer.prompts.get("question-1")).toMatchObject({
          status,
          localResolutionConfirmed: false,
          answeredElsewhere: status === "answered",
          submitting: false,
        });
      }
      if (status === "answered") {
        expect(splitPane.prompts.get("question-1")?.answers).toEqual({
          answers: { format: ["Compact"] },
        });
      }
      expect(client.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(resolutionCases)(
    "retains an authoritative $action until a same-client projection finishes hydration",
    async ({ resolve, status }) => {
      let finishList: ((result: unknown) => void) | undefined;
      const resolver = createQuestionClient();
      const client: QuestionClient = {
        request: vi.fn((method, params) =>
          method === "question.list"
            ? new Promise<unknown>((complete) => {
                finishList = complete;
              })
            : resolver.request(method, params),
        ),
      };
      const submitter = connectQuestionState(client);
      const stalePending = { ...submitter.prompts.get("question-1"), status: "pending" };
      const hydrating = createQuestionPromptState(vi.fn());
      states.push(hydrating);
      setQuestionPromptClient(hydrating, client);
      refreshPendingQuestionsWithRetry(hydrating, client);

      await resolve(submitter);

      expect(hydrating.unmatchedResolutions.get("question-1")).toMatchObject({
        id: "question-1",
        status,
      });
      finishList?.({ questions: [stalePending] });
      await vi.waitFor(() =>
        expect(hydrating.prompts.get("question-1")).toMatchObject({
          status,
          answeredElsewhere: status === "answered",
          localResolutionConfirmed: false,
        }),
      );
      expect(hydrating.unmatchedResolutions.size).toBe(0);
    },
  );

  it.each(resolutionCases)(
    "recovers a committed $action when a peer mounts before its ordered RPC response",
    async ({ resolve, status }) => {
      let finishResolution: ((result: QuestionResolveResult) => void) | undefined;
      let finishList: ((result: { questions: unknown[] }) => void) | undefined;
      const client: QuestionClient = {
        request: vi.fn((method) => {
          if (method === "question.resolve") {
            return new Promise<QuestionResolveResult>((complete) => {
              finishResolution = complete;
            });
          }
          if (method === "question.list") {
            return new Promise<{ questions: unknown[] }>((complete) => {
              finishList = complete;
            });
          }
          return Promise.resolve({ question: terminalRecord });
        }),
      };
      const submitter = connectQuestionState(client);
      const answers = { answers: { format: ["Compact"] } };
      const terminalRecord = {
        ...submitter.prompts.get("question-1"),
        status,
        ...(status === "answered" ? { answers } : {}),
      };
      const submission = resolve(submitter);
      const hydrating = createQuestionPromptState(vi.fn());
      states.push(hydrating);
      setQuestionPromptClient(hydrating, client);
      refreshPendingQuestionsWithRetry(hydrating, client);
      expect(vi.mocked(client.request).mock.calls.map(([method]) => method)).toEqual([
        "question.resolve",
        "question.list",
      ]);

      finishResolution?.(status === "answered" ? { status, answers } : { status });
      await submission;
      expect(hydrating.unmatchedResolutions.has("question-1")).toBe(true);
      finishList?.({ questions: [] });

      await vi.waitFor(() =>
        expect(hydrating.prompts.get("question-1")).toMatchObject({
          status,
          answeredElsewhere: status === "answered",
          localResolutionConfirmed: false,
        }),
      );
      expect(vi.mocked(client.request).mock.calls.map(([method]) => method)).toEqual([
        "question.resolve",
        "question.list",
        "question.get",
      ]);
      expect(hydrating.unmatchedResolutions.size).toBe(0);
    },
  );

  it.each(resolutionCases)(
    "does not leak a same-id $action into another Gateway client",
    async ({ resolve }) => {
      const submitter = connectQuestionState(createQuestionClient());
      const otherGateway = connectQuestionState(createQuestionClient());

      await resolve(submitter);

      expect(otherGateway.prompts.get("question-1")).toMatchObject({
        status: "pending",
        localResolutionConfirmed: false,
      });
    },
  );

  it("does not settle an unrelated same-client session question", async () => {
    const client = createQuestionClient();
    const submitter = connectQuestionState(client);
    const otherSession = createQuestionPromptState(vi.fn());
    states.push(otherSession);
    setQuestionPromptClient(otherSession, client);
    requestQuestion(otherSession, "other-session-question");

    await cancelQuestionPrompt(submitter, "question-1");

    expect(otherSession.prompts.get("other-session-question")?.status).toBe("pending");
  });

  it("unregisters a disconnected peer without discarding its reconnectable prompt", async () => {
    const client = createQuestionClient();
    const submitter = connectQuestionState(client);
    const disconnected = connectQuestionState(client);
    setQuestionPromptClient(disconnected, null);

    await cancelQuestionPrompt(submitter, "question-1");

    expect(disconnected.prompts.get("question-1")?.status).toBe("pending");
    setQuestionPromptClient(disconnected, client);
    expect(disconnected.prompts.get("question-1")?.status).toBe("pending");
  });

  it("unregisters a disposed peer before a sibling receives its RPC result", async () => {
    const client = createQuestionClient();
    const submitter = connectQuestionState(client);
    const onPeerChange = vi.fn();
    const disposed = connectQuestionState(client, onPeerChange);
    onPeerChange.mockClear();
    disposeQuestionPromptState(disposed);

    await cancelQuestionPrompt(submitter, "question-1");

    expect(disposed.prompts.get("question-1")?.status).toBe("pending");
    expect(onPeerChange).not.toHaveBeenCalled();
  });

  it.each(resolutionCases)(
    "publishes a committed $action to surviving peers after the submitting pane is disposed",
    async ({ resolve, status }) => {
      let finishRequest: ((result: QuestionResolveResult) => void) | undefined;
      const client: QuestionClient = {
        request: vi.fn(
          () =>
            new Promise<QuestionResolveResult>((complete) => {
              finishRequest = complete;
            }),
        ),
      };
      const onSubmitterChange = vi.fn();
      const submitter = connectQuestionState(client, onSubmitterChange);
      const peer = connectQuestionState(client);
      const sidebar = connectQuestionState(client);
      const submission = resolve(submitter);
      onSubmitterChange.mockClear();
      disposeQuestionPromptState(submitter);
      const result: QuestionResolveResult =
        status === "answered"
          ? { status, answers: { answers: { format: ["Compact"] } } }
          : { status };
      finishRequest?.(result);

      await submission;

      expect(submitter.prompts.get("question-1")?.status).toBe("pending");
      expect(onSubmitterChange).not.toHaveBeenCalled();
      for (const projection of [peer, sidebar]) {
        expect(projection.prompts.get("question-1")).toMatchObject({
          status,
          answeredElsewhere: status === "answered",
          localResolutionConfirmed: false,
          submitting: false,
        });
      }
    },
  );

  it("does not deliver an old client result to a peer rebound to another Gateway", async () => {
    const firstClient = createQuestionClient();
    const submitter = connectQuestionState(firstClient);
    const migrated = connectQuestionState(firstClient);
    setQuestionPromptClient(migrated, createQuestionClient());
    requestQuestion(migrated);

    await cancelQuestionPrompt(submitter, "question-1");

    expect(migrated.prompts.get("question-1")?.status).toBe("pending");
  });

  it.each(["pending", "answered"] as const)(
    "purges a disposed $status question and unmatched private outcome before attaching another Gateway",
    (status) => {
      const firstClient = createQuestionClient();
      const reused = connectQuestionState(firstClient);
      if (status === "answered") {
        handleQuestionPromptEvent(reused, {
          event: "question.resolved",
          payload: {
            id: "question-1",
            status,
            answers: { answers: { format: ["Private account answer"] } },
          },
        });
      }
      handleQuestionPromptEvent(reused, {
        event: "question.resolved",
        payload: { id: "private-unmatched-question", status: "cancelled" },
      });
      disposeQuestionPromptState(reused);

      setQuestionPromptClient(reused, createQuestionClient());

      expect(reused.prompts.size).toBe(0);
      expect(reused.unmatchedResolutions.size).toBe(0);
    },
  );

  it("keeps and reconnects a disposed question projection on its original Gateway", async () => {
    const client = createQuestionClient();
    const submitter = connectQuestionState(client);
    const remounted = connectQuestionState(client);
    handleQuestionPromptEvent(remounted, {
      event: "question.resolved",
      payload: { id: "same-gateway-unmatched-question", status: "cancelled" },
    });
    disposeQuestionPromptState(remounted);
    setQuestionPromptClient(remounted, client);

    expect(remounted.prompts.get("question-1")?.status).toBe("pending");
    expect(remounted.unmatchedResolutions.has("same-gateway-unmatched-question")).toBe(true);
    await cancelQuestionPrompt(submitter, "question-1");
    expect(remounted.prompts.get("question-1")?.status).toBe("cancelled");
  });

  it("publishes and expires a pending question recovered only from question.list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const client: QuestionClient = {
      request: vi.fn(async () => ({ questions: [pending] })),
    };
    const existing = connectQuestionState(client, vi.fn(), Date.now() + 1_000);
    const pending = { ...existing.prompts.get("question-1"), status: "pending" };
    const onChange = vi.fn();
    const hydrated = createQuestionPromptState(onChange);
    states.push(hydrated);
    setQuestionPromptClient(hydrated, client);

    refreshPendingQuestionsWithRetry(hydrated, client);
    await vi.advanceTimersByTimeAsync(0);

    expect(onChange).toHaveBeenCalledOnce();
    expect(hydrated.prompts.get("question-1")?.status).toBe("pending");
    expect(hydrated.tickTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hydrated.prompts.get("question-1")).toMatchObject({
      status: "expired",
      locallyExpired: true,
    });
  });

  it("expires remounted pane and sidebar questions while their Gateway hydration remains stalled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const stalledList = new Promise<never>(() => {});
    const client: QuestionClient = { request: vi.fn(() => stalledList) };
    const expiresAtMs = Date.now() + 1_000;
    const pane = connectQuestionState(client, vi.fn(), expiresAtMs);
    const sidebar = connectQuestionState(client, vi.fn(), expiresAtMs);
    for (const projection of [pane, sidebar]) {
      disposeQuestionPromptState(projection);
      setQuestionPromptClient(projection, client);
      refreshPendingQuestionsWithRetry(projection, client);
    }
    expect(client.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);

    for (const projection of [pane, sidebar]) {
      expect(projection.prompts.get("question-1")).toMatchObject({
        status: "expired",
        locallyExpired: true,
        submitting: false,
      });
    }
  });

  it("rejects a stale same-client hydration result after the sidebar remounts", async () => {
    const pendingLists: Array<(value: unknown) => void> = [];
    const client: QuestionClient = {
      request: vi.fn(
        (method: string) =>
          new Promise<unknown>((resolve) => {
            if (method === "question.list") {
              pendingLists.push(resolve);
            }
          }),
      ),
    };
    const remounted = connectQuestionState(client);
    refreshPendingQuestionsWithRetry(remounted, client);
    disposeQuestionPromptState(remounted);
    setQuestionPromptClient(remounted, client);
    refreshPendingQuestionsWithRetry(remounted, client);
    expect(pendingLists).toHaveLength(2);

    pendingLists[0]?.({
      questions: [
        {
          ...remounted.prompts.get("question-1"),
          id: "stale-before-remount",
          status: "pending",
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(remounted.prompts.has("stale-before-remount")).toBe(false);
  });

  it("does not publish an old request rejected when its Gateway reconnects", async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    const client: QuestionClient = {
      request: vi.fn(
        () =>
          new Promise<QuestionResolveResult>((_resolve, reject) => {
            rejectRequest = reject;
          }),
      ),
    };
    const submitter = connectQuestionState(client);
    const peer = connectQuestionState(client);
    const submission = cancelQuestionPrompt(submitter, "question-1");
    // The protocol rejects pending requests before its reconnect lifecycle.
    rejectRequest?.(new Error("gateway closed"));
    for (const projection of [submitter, peer]) {
      setQuestionPromptClient(projection, null);
      setQuestionPromptClient(projection, client);
    }

    await submission;

    expect(submitter.prompts.get("question-1")?.status).toBe("pending");
    expect(peer.prompts.get("question-1")?.status).toBe("pending");
  });

  it("skips a peer rebound to a newer generation during reentrant publication", async () => {
    const client = createQuestionClient();
    const submitter = connectQuestionState(client);
    let publishStarted = false;
    const reentrant = connectQuestionState(client, () => {
      if (!publishStarted) {
        return;
      }
      publishStarted = false;
      setQuestionPromptClient(rebound, null);
      setQuestionPromptClient(rebound, client);
    });
    const rebound = connectQuestionState(client);
    publishStarted = true;

    await cancelQuestionPrompt(submitter, "question-1");

    expect(reentrant.prompts.get("question-1")?.status).toBe("cancelled");
    expect(rebound.prompts.get("question-1")?.status).toBe("pending");
  });
});

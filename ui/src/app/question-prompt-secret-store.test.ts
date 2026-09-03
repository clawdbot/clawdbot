// @vitest-environment node
// Store-bound questions never retain submitted credentials in terminal UI state.
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
import type { Question, QuestionRecord, QuestionResolveResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
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
type SecretBinding = NonNullable<Question["secretStore"]>;
type PromptState = ReturnType<typeof createQuestionPromptState>;

const states: PromptState[] = [];
const storedAnswer = {
  status: "answered",
  answers: { answers: { secret_value: ["stored"] } },
} satisfies QuestionResolveResult;

function requestedSecret(
  secretStore: SecretBinding = { name: "TEST_API_KEY", kind: "secret" },
  overrides: Partial<Question> = {},
): QuestionRecord {
  return {
    id: "question-1",
    questions: [
      {
        questionId: "secret_value",
        header: "API key",
        question: "Provide the fake test credential.",
        options: [],
        isSecret: true,
        secretStore,
        ...overrides,
      },
    ],
    agentId: "main",
    sessionKey: "agent:main:main",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
  };
}

function createSecretPrompt(request?: RequestFn, record = requestedSecret()) {
  const state = createQuestionPromptState(vi.fn());
  states.push(state);
  const client = request ? { request } : null;
  if (client) {
    setQuestionPromptClient(state, client);
  }
  handleQuestionPromptEvent(state, { event: "question.requested", payload: record });
  const prompt = state.prompts.get(record.id);
  if (!prompt) {
    throw new Error("valid secret question was not registered");
  }
  return { state, prompt, client };
}

afterEach(() => {
  for (const state of states.splice(0)) {
    disposeQuestionPromptState(state);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("store-bound question normalization", () => {
  it("preserves protocol-derived binding and replacement metadata", () => {
    const secretStore: SecretBinding = {
      name: "TEST_API_KEY",
      kind: "secret",
      allowedHosts: ["api.example.test"],
      reason: "The test agent needs a fake credential.",
    };
    const secretStoreExisting: NonNullable<Question["secretStoreExisting"]> = {
      updatedAtMs: 1_234,
      updatedBy: "operator@example.test",
    };
    const { prompt } = createSecretPrompt(
      undefined,
      requestedSecret(secretStore, { secretStoreExisting }),
    );

    expect(prompt.questions[0]).toMatchObject({ isSecret: true, secretStore, secretStoreExisting });
  });

  it.each([
    { label: "non-boolean secrecy", overrides: { isSecret: "true" } },
    {
      label: "duplicate hosts",
      overrides: {
        secretStore: {
          name: "TEST_API_KEY",
          kind: "secret",
          allowedHosts: ["api.example.test", "api.example.test"],
        },
      },
    },
    {
      label: "hosts on environment entries",
      overrides: {
        secretStore: {
          name: "TEST_ENV_VALUE",
          kind: "env",
          allowedHosts: ["api.example.test"],
        },
      },
    },
    {
      label: "invalid replacement metadata",
      overrides: { secretStoreExisting: { updatedAtMs: -1 } },
    },
  ])("rejects $label", ({ overrides }) => {
    const state = createQuestionPromptState(vi.fn());
    states.push(state);
    const record = requestedSecret();

    expect(
      handleQuestionPromptEvent(state, {
        event: "question.requested",
        payload: { ...record, questions: [{ ...record.questions[0], ...overrides }] },
      }),
    ).toBe(false);
  });
});

describe("store-bound question submission", () => {
  it.each([
    {
      label: "untouched proposed hosts",
      binding: { name: "TEST_API_KEY", kind: "secret", allowedHosts: ["proposed.example.test"] },
      draft: undefined,
      expectedHosts: ["proposed.example.test"],
    },
    {
      label: "edited comma-and-whitespace-separated hosts",
      binding: { name: "TEST_API_KEY", kind: "secret" },
      draft: " first.example.test, second.example.test\nthird.example.test ",
      expectedHosts: ["first.example.test", "second.example.test", "third.example.test"],
    },
    {
      label: "an explicitly cleared host proposal",
      binding: { name: "TEST_API_KEY", kind: "secret", allowedHosts: ["proposed.example.test"] },
      draft: "  ",
      expectedHosts: [],
    },
    {
      label: "an untouched secret without proposed hosts",
      binding: { name: "TEST_API_KEY", kind: "secret" },
      draft: undefined,
      expectedHosts: undefined,
    },
    {
      label: "an environment entry despite stale host input",
      binding: { name: "TEST_ENV_VALUE", kind: "env" },
      draft: "ignored.example.test",
      expectedHosts: undefined,
    },
  ] satisfies Array<{
    label: string;
    binding: SecretBinding;
    draft: string | undefined;
    expectedHosts: string[] | undefined;
  }>)("submits $label", async ({ binding, draft, expectedHosts }) => {
    const request = vi.fn<RequestFn>(async () => storedAnswer);
    const { state, prompt } = createSecretPrompt(request, requestedSecret(binding));
    if (draft !== undefined) {
      prompt.secretStoreAllowedHostsDraft = draft;
    }

    await submitQuestionPrompt(state, prompt.id, { secret_value: ["fake-secret-test-value"] });

    expect(request).toHaveBeenCalledWith(
      "question.resolve",
      {
        id: prompt.id,
        answers: { answers: { secret_value: ["fake-secret-test-value"] } },
        ...(expectedHosts !== undefined ? { secretStoreAllowedHosts: expectedHosts } : {}),
      },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
    expect(prompt.submittedAnswers).toEqual(storedAnswer.answers);
  });

  it("preserves a secret draft on validation failure and clears it after successful retry", async () => {
    const fakeSecret = "fake-secret-retry-test-value";
    const request = vi
      .fn<RequestFn>()
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Allowed host is invalid." }),
      )
      .mockResolvedValueOnce(storedAnswer);
    const { state, prompt } = createSecretPrompt(request);
    prompt.drafts.set("secret_value", { selected: new Set(), freeText: fakeSecret });

    await submitQuestionPrompt(state, prompt.id, { secret_value: [fakeSecret] });

    expect(prompt).toMatchObject({
      status: "pending",
      submitting: false,
      error: "Allowed host is invalid.",
      submittedAnswers: storedAnswer.answers,
    });
    expect(prompt.drafts.get("secret_value")?.freeText).toBe(fakeSecret);

    await submitQuestionPrompt(state, prompt.id, { secret_value: [fakeSecret] });

    expect(prompt).toMatchObject({
      status: "answered",
      answers: storedAnswer.answers,
      submittedAnswers: storedAnswer.answers,
    });
    expect(prompt.drafts.has("secret_value")).toBe(false);
  });
});

describe("store-bound question terminal cleanup", () => {
  it("forgets the secret draft when the local deadline expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const record = requestedSecret();
    record.expiresAtMs = Date.now() + 1_000;
    const { prompt } = createSecretPrompt(undefined, record);
    prompt.drafts.set("secret_value", {
      selected: new Set(),
      freeText: "fake-secret-expired-test-value",
    });

    vi.advanceTimersByTime(1_000);

    expect(prompt.status).toBe("expired");
    expect(prompt.drafts.has("secret_value")).toBe(false);
  });

  it("forgets the secret draft when recovery proves the question unavailable", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "question.list") {
        return { questions: [] };
      }
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "question was not found",
        details: { reason: "QUESTION_NOT_FOUND" },
      });
    });
    const { state, prompt, client } = createSecretPrompt(request);
    prompt.drafts.set("secret_value", {
      selected: new Set(),
      freeText: "fake-secret-unavailable-test-value",
    });
    if (!client) {
      throw new Error("connected secret question has no client");
    }

    refreshPendingQuestionsWithRetry(state, client);
    await waitForFast(() => expect(prompt.status).toBe("unavailable"));

    expect(prompt.drafts.has("secret_value")).toBe(false);
  });
});

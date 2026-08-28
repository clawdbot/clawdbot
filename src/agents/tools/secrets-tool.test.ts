import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimPendingAgentQuestionAnswer } from "../harness/gateway-question.js";
import { reserveAskUserPromptDelivery, settleAskUserPromptDelivery } from "./ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./ask-user-tool.test-support.js";
import { createSecretsTool, normalizeSecretsRequestParams } from "./secrets-tool.js";

type GatewayCall = NonNullable<Parameters<typeof createSecretsTool>[0]["gatewayCall"]>;

function gatewayStub(
  implementation: (
    method: string,
    opts: Record<string, unknown>,
    params: Record<string, unknown>,
    extra?: { signal?: AbortSignal; requireAgentRuntimeIdentity?: boolean },
  ) => Promise<unknown>,
) {
  const mock = vi.fn(implementation);
  return { mock, call: mock as unknown as GatewayCall };
}

function requestedQuestionId(mock: ReturnType<typeof gatewayStub>["mock"]): string {
  const request = mock.mock.calls.find(([method]) => method === "question.request");
  const questionId = request?.[2].id;
  if (typeof questionId !== "string") {
    throw new Error("question.request did not include an id");
  }
  return questionId;
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
});

describe("secrets request normalization", () => {
  it("builds one store-bound secret question and clamps its timeout", () => {
    const normalized = normalizeSecretsRequestParams({
      action: "request",
      name: "SERVICE_API_KEY",
      kind: "secret",
      allowedHosts: ["api.example.test"],
      reason: "Deploy the service",
      timeoutSeconds: 5,
    });

    expect(normalized).toEqual({
      name: "SERVICE_API_KEY",
      kind: "secret",
      allowedHosts: ["api.example.test"],
      reason: "Deploy the service",
      timeoutSeconds: 30,
      questions: [
        {
          questionId: "secret_value",
          header: "API key",
          question: "Provide the secret for SERVICE_API_KEY. Deploy the service",
          options: [],
          isSecret: true,
          secretStore: {
            name: "SERVICE_API_KEY",
            kind: "secret",
            allowedHosts: ["api.example.test"],
            reason: "Deploy the service",
          },
        },
      ],
    });
    expect(
      normalizeSecretsRequestParams({
        name: "SERVICE_SETTING",
        kind: "secret",
        timeoutSeconds: 9_999,
      }).timeoutSeconds,
    ).toBe(3_600);
    expect(
      Value.Check(createSecretsTool({}).parameters, {
        action: "set",
        name: "SERVICE_API_KEY",
        value: "test-secret-value-123",
      }),
    ).toBe(false);
  });

  it.each([
    ["lowercase names", { name: "bad_name", kind: "secret" }, "uppercase"],
    ["unknown entry kinds", { name: "VALID_NAME", kind: "password" }, "kind must be"],
    [
      "environment-value requests the model could read back",
      { name: "VALID_NAME", kind: "env" },
      'kind must be "secret"',
    ],
    [
      "duplicate allowed hosts",
      { name: "VALID_NAME", kind: "secret", allowedHosts: ["a.test", "a.test"] },
      "unique",
    ],
    [
      "oversized reasons",
      { name: "VALID_NAME", kind: "secret", reason: "r".repeat(201) },
      "at most 200",
    ],
    ["fractional timeouts", { name: "VALID_NAME", kind: "secret", timeoutSeconds: 1.5 }, "integer"],
  ])("rejects %s before contacting the gateway", (_label, params, message) => {
    expect(() => normalizeSecretsRequestParams(params)).toThrow(message);
  });
});

describe("secrets tool", () => {
  it("stores through a human-only question and returns metadata without claiming chat text", async () => {
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _options, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.get") {
        return { question: { questions: [{ secretStoreExisting: { updatedAtMs: 123 } }] } };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      agentId: "main",
      sessionKey: "agent:main:secrets",
      runId: "run-secrets",
      gatewayCall: gateway.call,
    });
    const pending = tool.execute("call-secret", {
      action: "request",
      name: "SERVICE_API_KEY",
      kind: "secret",
      allowedHosts: ["api.example.test"],
      reason: "Deploy the service",
    });
    await vi.waitFor(() => expect(finishWait).toBeTypeOf("function"));

    await expect(
      claimPendingAgentQuestionAnswer({
        sessionKey: "agent:main:secrets",
        text: "test-secret-value-123",
      }),
    ).resolves.toBe(false);
    finishWait?.({
      status: "answered",
      answers: { answers: { secret_value: ["stored"] } },
    });
    const result = await pending;

    expect(result.details).toEqual({
      status: "stored",
      name: "SERVICE_API_KEY",
      kind: "secret",
      allowedHosts: ["api.example.test"],
      replacedExisting: true,
      ref: { source: "store", id: "SERVICE_API_KEY" },
    });
    expect(JSON.stringify(result)).not.toContain("test-secret-value-123");
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('{source:"store", id:"SERVICE_API_KEY"}'),
    });
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.request",
      {},
      expect.objectContaining({
        id: expect.stringMatching(/^ask_[a-f0-9]{32}$/),
        agentId: "main",
        sessionKey: "agent:main:secrets",
        runId: "run-secrets",
        timeoutMs: 900_000,
        questions: [
          expect.objectContaining({
            questionId: "secret_value",
            options: [],
            isSecret: true,
            secretStore: {
              name: "SERVICE_API_KEY",
              kind: "secret",
              allowedHosts: ["api.example.test"],
              reason: "Deploy the service",
            },
          }),
        ],
      }),
      // Store-bound minting is admin-gated server-side; the tool must declare
      // the scope explicitly instead of the questions-scope default.
      { scopes: ["operator.admin"] },
    );
  });

  it("continues a registered credential request when optional replacement metadata is unavailable", async () => {
    const gateway = gatewayStub(async (method, _options, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.get") {
        throw new Error("metadata temporarily unavailable");
      }
      return { status: "answered", answers: { answers: { secret_value: ["stored"] } } };
    });

    const result = await createSecretsTool({ gatewayCall: gateway.call }).execute("call-metadata", {
      action: "request",
      name: "SERVICE_SETTING",
      kind: "secret",
    });

    expect(result.details).toMatchObject({
      status: "stored",
      kind: "secret",
      replacedExisting: false,
    });
    expect(gateway.mock.mock.calls.some(([method]) => method === "question.resolve")).toBe(false);
  });

  it.each(["pending", "expired", "cancelled"] as const)(
    "returns no_answer when a credential request is %s",
    async (status) => {
      const gateway = gatewayStub(async (method, _options, params) => {
        if (method === "question.request") {
          return { id: params.id };
        }
        if (method === "question.get") {
          return { question: { questions: [{}] } };
        }
        return { status };
      });

      const result = await createSecretsTool({
        sessionKey: `agent:main:${status}`,
        gatewayCall: gateway.call,
      }).execute(`call-${status}`, { action: "request", name: "SERVICE_API_KEY", kind: "secret" });

      expect(result.details).toEqual({ status: "no_answer" });
      if (status === "pending") {
        expect(gateway.mock).toHaveBeenCalledWith(
          "question.resolve",
          { timeoutMs: 10_000 },
          {
            id: requestedQuestionId(gateway.mock),
            cancel: true,
            resolvedBy: "wait-timeout",
          },
        );
      }
    },
  );

  it("keeps a credential stored when the human answers during the wait timeout", async () => {
    // The Gateway rejects the late cancel as terminal and hands back the answer;
    // the value is already in the store, so the tool must not report no_answer.
    const terminal = Object.assign(new Error("question is already answered"), {
      name: "GatewayClientRequestError",
      details: { reason: "QUESTION_ALREADY_TERMINAL" },
    });
    let waitCalls = 0;
    const gateway = gatewayStub(async (method, _options, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.get") {
        return { question: { questions: [{}] } };
      }
      if (method === "question.resolve") {
        throw terminal;
      }
      waitCalls += 1;
      return waitCalls === 1
        ? { status: "pending" }
        : { status: "answered", answers: { answers: { secret_value: ["stored"] } } };
    });

    const result = await createSecretsTool({
      sessionKey: "agent:main:late-answer",
      gatewayCall: gateway.call,
    }).execute("call-late-answer", {
      action: "request",
      name: "SERVICE_API_KEY",
      kind: "secret",
    });

    expect(result.details).toMatchObject({ status: "stored", name: "SERVICE_API_KEY" });
  });

  it("cancels a registered credential request when its agent run aborts", async () => {
    const controller = new AbortController();
    const gateway = gatewayStub(async (method, _options, params, extra) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.get") {
        return { question: { questions: [{}] } };
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
    const pending = createSecretsTool({
      sessionKey: "agent:main:secret-abort",
      gatewayCall: gateway.call,
    }).execute(
      "call-secret-abort",
      { action: "request", name: "SERVICE_API_KEY", kind: "secret" },
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(gateway.mock.mock.calls.some(([method]) => method === "question.waitAnswer")).toBe(
        true,
      ),
    );

    controller.abort(new Error("stop"));

    await expect(pending).rejects.toThrow("aborted");
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.resolve",
      { timeoutMs: 10_000 },
      { id: requestedQuestionId(gateway.mock), cancel: true, resolvedBy: "run-abort" },
    );
  });

  it("shares the existing subscriber prompt reservation and settlement lifecycle", async () => {
    const sessionKey = "agent:main:secret-prompt";
    const args = { action: "request", name: "SERVICE_API_KEY", kind: "secret" };
    const normalized = normalizeSecretsRequestParams(args);
    const reservation = reserveAskUserPromptDelivery({
      toolCallId: "call-secret-prompt",
      sessionKey,
      questions: normalized.questions,
      timeoutSeconds: normalized.timeoutSeconds,
    });
    if (!reservation) {
      throw new Error("expected secret prompt reservation");
    }
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _options, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.get") {
        return { question: { questions: [{}] } };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const pending = createSecretsTool({ sessionKey, gatewayCall: gateway.call }).execute(
      "call-secret-prompt",
      args,
    );
    await vi.waitFor(() => expect(finishWait).toBeTypeOf("function"));

    settleAskUserPromptDelivery(reservation.questionId);
    finishWait?.({
      status: "answered",
      answers: { answers: { secret_value: ["stored"] } },
    });

    await expect(pending).resolves.toMatchObject({ details: { status: "stored" } });
  });

  it("lists store metadata and environment previews", async () => {
    const entries = [
      {
        name: "SERVICE_API_KEY",
        kind: "secret",
        allowedHosts: ["api.example.test"],
        createdAtMs: 0,
        updatedAtMs: 0,
        updatedBy: "operator:alice",
        scopeKind: "team",
        scopeId: "",
      },
      {
        name: "SERVICE_MODE",
        kind: "env",
        value: "preview-value",
        createdAtMs: 0,
        updatedAtMs: 0,
        scopeKind: "team",
        scopeId: "",
      },
    ];
    const gateway = gatewayStub(async () => ({ entries }));

    const result = await createSecretsTool({ gatewayCall: gateway.call }).execute("call-list", {
      action: "list",
    });

    expect(result.details).toEqual({ entries });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("SERVICE_API_KEY | secret | hosts: api.example.test"),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("value: preview-value"),
    });
    expect(gateway.mock).toHaveBeenCalledWith("secrets.store.list", {}, {}, undefined);
  });

  it("requires verified agent runtime identity when deleting a store entry", async () => {
    const gateway = gatewayStub(async () => ({ ok: true, reloaded: false }));

    const result = await createSecretsTool({ gatewayCall: gateway.call }).execute("call-delete", {
      action: "delete",
      name: "SERVICE_API_KEY",
    });

    expect(result.details).toEqual({ ok: true, reloaded: false });
    expect(gateway.mock).toHaveBeenCalledWith(
      "secrets.store.delete",
      {},
      { name: "SERVICE_API_KEY" },
      { requireAgentRuntimeIdentity: true },
    );
  });
});

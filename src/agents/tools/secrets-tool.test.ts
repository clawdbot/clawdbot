import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SecretRefSchema } from "../../config/zod-schema.core.js";
import { isBuiltInDefaultSecretProviderRef } from "../../secrets/ref-contract.js";
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

const storedAnswer = { status: "answered", answers: { answers: { secret_value: ["stored"] } } };
const storeMetadata = {
  name: "SERVICE_API_KEY",
  createdAtMs: 0,
  updatedAtMs: 0,
  scopeKind: "team",
  scopeId: "",
};
const editedPolicy = { status: "available", allowedHosts: ["api.analytics.example"] };
const secretEntry = { ...storeMetadata, kind: "secret", allowedHosts: editedPolicy.allowedHosts };
const unrelatedEnv = {
  ...storeMetadata,
  name: "UNRELATED_ENV",
  kind: "env",
  value: "private-env-value",
};

function storedRequestGateway(readMetadata: () => Promise<unknown>) {
  return gatewayStub(async (method, _options, params) => {
    if (method === "question.request") {
      return { id: params.id };
    }
    if (method === "secrets.store.list") {
      return await readMetadata();
    }
    return storedAnswer;
  });
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
          question: "Provide the secret for SERVICE_API_KEY.",
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
  it.each<{ label: string; config: OpenClawConfig }>([
    { label: "built-in store", config: {} },
    { label: "renamed store default", config: { secrets: { defaults: { store: "teamstore" } } } },
    {
      label: "store default shared with another source",
      config: {
        secrets: {
          defaults: { store: "teamstore" },
          providers: { teamstore: { source: "env" } },
        },
      },
    },
  ])("returns a valid $label ref without claiming chat text", async ({ config }) => {
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _options, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      if (method === "secrets.store.list") {
        return { entries: [unrelatedEnv, secretEntry] };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config,
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

    const ref = SecretRefSchema.parse(asNullableRecord(result.details)?.ref);
    expect(ref.source).toBe("store");
    expect(ref.id).toBe("SERVICE_API_KEY");
    expect(isBuiltInDefaultSecretProviderRef(config, ref)).toBe(true);
    expect(result.details).toEqual({
      status: "stored",
      name: "SERVICE_API_KEY",
      kind: "secret",
      ref,
      currentPolicy: editedPolicy,
    });
    expect(JSON.stringify(result)).not.toContain("test-secret-value-123");
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Use the returned ref"),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("currentPolicy"),
    });
    expect(JSON.stringify(result)).not.toContain("api.example.test");
    expect(JSON.stringify(result)).not.toContain("UNRELATED_ENV");
    expect(JSON.stringify(result)).not.toContain("private-env-value");
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual([
      "question.request",
      "question.waitAnswer",
      "secrets.store.list",
    ]);
    expect(gateway.mock).toHaveBeenLastCalledWith("secrets.store.list", {}, {}, undefined);
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
      { scopes: ["operator.admin"], requireAgentRuntimeIdentity: true },
    );
  });

  it.each(["pending", "expired", "cancelled"] as const)(
    "returns no_answer when a credential request is %s",
    async (status) => {
      const gateway = gatewayStub(async (method, _options, params) => {
        if (method === "question.request") {
          return { id: params.id };
        }
        return { status };
      });

      const result = await createSecretsTool({
        sessionKey: `agent:main:${status}`,
        gatewayCall: gateway.call,
      }).execute(`call-${status}`, { action: "request", name: "SERVICE_API_KEY", kind: "secret" });

      expect(result.details).toEqual({ status: "no_answer" });
      expect(gateway.mock.mock.calls.some(([method]) => method === "secrets.store.list")).toBe(
        false,
      );
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

  it.each([
    { boundary: "wait timeout", marker: "stored", abort: false },
    { boundary: "delivery failure", marker: "stored", abort: false },
    { boundary: "wait timeout", marker: "unexpected", abort: false },
    { boundary: "delivery failure", marker: "unexpected", abort: false },
    { boundary: "delivery failure", marker: "stored", abort: true },
  ])(
    "consumes canonical answers after $boundary (marker=$marker, abort=$abort)",
    async ({ boundary, marker, abort }) => {
      const terminal = Object.assign(new Error("question is already answered"), {
        name: "GatewayClientRequestError",
        details: { reason: "QUESTION_ALREADY_TERMINAL" },
      });
      const sessionKey = "agent:main:late-answer";
      const toolCallId = "call-late-answer";
      const args = { action: "request", name: "SERVICE_API_KEY", kind: "secret" };
      const normalized = normalizeSecretsRequestParams(args);
      const reservation =
        boundary === "delivery failure"
          ? reserveAskUserPromptDelivery({
              toolCallId,
              sessionKey,
              questions: normalized.questions,
              timeoutSeconds: normalized.timeoutSeconds,
            })
          : undefined;
      const firstWait = createDeferred<unknown>();
      const controller = new AbortController();
      let waitCalls = 0;
      const gateway = gatewayStub(async (method, _options, params) => {
        if (method === "question.request") {
          return { id: params.id };
        }
        if (method === "question.resolve") {
          if (abort) {
            await Promise.resolve();
            controller.abort(new Error("run stopped"));
          }
          throw terminal;
        }
        if (method === "secrets.store.list") {
          return { entries: [secretEntry] };
        }
        waitCalls += 1;
        if (waitCalls === 1) {
          return boundary === "wait timeout" ? { status: "pending" } : await firstWait.promise;
        }
        return { status: "answered", answers: { answers: { secret_value: [marker] } } };
      });
      const outcome = createSecretsTool({ sessionKey, gatewayCall: gateway.call })
        .execute(toolCallId, args, controller.signal)
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      try {
        if (reservation) {
          await vi.waitFor(() => expect(waitCalls).toBe(1));
          settleAskUserPromptDelivery(reservation.questionId, new Error("transport failed"));
        }
        if (abort) {
          await expect(outcome).resolves.toMatchObject({ error: new Error("run stopped") });
        } else if (marker !== "stored") {
          await expect(outcome).resolves.toMatchObject({
            error: new Error("credential request returned an unexpected answer marker"),
          });
        } else {
          await expect(outcome).resolves.toMatchObject({
            result: {
              details: { status: "stored", name: "SERVICE_API_KEY", currentPolicy: editedPolicy },
            },
          });
        }
        expect(
          gateway.mock.mock.calls.filter(([method]) => method === "secrets.store.list"),
        ).toHaveLength(!abort && marker === "stored" ? 1 : 0);
        expect(
          gateway.mock.mock.calls.filter(([method]) => method === "question.resolve"),
        ).toHaveLength(1);
      } finally {
        firstWait.resolve({ status: "cancelled" });
        await outcome;
      }
    },
  );

  const longHost = `${"a".repeat(62)}.${"b".repeat(62)}.${"c".repeat(62)}.${"d".repeat(59)}.test`;
  const boundaryHosts = [longHost, longHost.slice(1)];
  const oversizedHosts = [longHost, `e${longHost.slice(1)}`];
  it.each([
    {
      label: "empty hosts",
      metadata: { entries: [{ ...secretEntry, allowedHosts: [] }] },
      currentPolicy: { status: "available", allowedHosts: [] },
    },
    {
      label: "512-character complete array",
      metadata: { entries: [{ ...secretEntry, allowedHosts: boundaryHosts }] },
      currentPolicy: { status: "available", allowedHosts: boundaryHosts },
    },
    {
      label: "513-character array",
      metadata: { entries: [{ ...secretEntry, allowedHosts: oversizedHosts }] },
      currentPolicy: { status: "omitted", allowedHostCount: 2 },
    },
    {
      label: "absent host policy",
      metadata: { entries: [{ ...storeMetadata, kind: "secret" }] },
      currentPolicy: { status: "unavailable" },
    },
    {
      label: "missing entry",
      metadata: { entries: [unrelatedEnv] },
      currentPolicy: { status: "missing" },
    },
    {
      label: "kind changed to env",
      metadata: { entries: [{ ...unrelatedEnv, name: storeMetadata.name }] },
      currentPolicy: { status: "kind_changed" },
    },
    {
      label: "read rejection",
      metadata: new Error("private-env-value"),
      currentPolicy: { status: "unavailable" },
    },
    {
      label: "invalid inventory",
      metadata: { entries: "private-env-value" },
      currentPolicy: { status: "unavailable" },
    },
    {
      label: "invalid secret fields",
      metadata: { entries: [{ ...secretEntry, value: "private-env-value" }] },
      currentPolicy: { status: "unavailable" },
    },
  ])("preserves stored truth with $label metadata", async ({ metadata, currentPolicy }) => {
    const gateway = storedRequestGateway(async () => {
      if (metadata instanceof Error) {
        throw metadata;
      }
      return metadata;
    });
    const result = await createSecretsTool({ gatewayCall: gateway.call }).execute("policy-result", {
      action: "request",
      name: "SERVICE_API_KEY",
      allowedHosts: ["proposed.example.test"],
    });
    expect(result.details).toEqual({
      status: "stored",
      name: "SERVICE_API_KEY",
      kind: "secret",
      ref: { source: "store", provider: "default", id: "SERVICE_API_KEY" },
      currentPolicy,
    });
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual([
      "question.request",
      "question.waitAnswer",
      "secrets.store.list",
    ]);
    const text = result.content[0];
    expect(text?.type).toBe("text");
    if (text?.type !== "text") {
      throw new Error("expected text result");
    }
    expect(text.text.length).toBeLessThan(1800);
    expect(text.text).not.toMatch(/private-env-value|UNRELATED_ENV|proposed\.example\.test/);
    if (currentPolicy.status === "available") {
      const hosts = currentPolicy.allowedHosts!;
      expect(JSON.stringify(hosts).length).toBeLessThanOrEqual(512);
      for (const host of hosts) {
        expect(text.text.split(JSON.stringify(host))).toHaveLength(2);
      }
    } else {
      expect(text.text).not.toContain(longHost.slice(0, 62));
      expect(text.text).not.toContain("allowedHosts");
    }
  });

  it.each(["resolve", "reject"] as const)(
    "keeps abort authoritative when metadata %ss",
    async (settlement) => {
      const metadata = createDeferred<unknown>();
      const controller = new AbortController();
      const gateway = storedRequestGateway(() => metadata.promise);
      const outcome = createSecretsTool({ gatewayCall: gateway.call })
        .execute("abort-policy", { action: "request", name: "SERVICE_API_KEY" }, controller.signal)
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      try {
        await vi.waitFor(() =>
          expect(gateway.mock.mock.calls.some(([method]) => method === "secrets.store.list")).toBe(
            true,
          ),
        );
        expect(gateway.mock).toHaveBeenLastCalledWith(
          "secrets.store.list",
          {},
          {},
          { signal: controller.signal },
        );
        controller.abort(new Error("run stopped during metadata"));
        if (settlement === "reject") {
          metadata.reject(new Error("private-env-value"));
        } else {
          metadata.resolve({ entries: [secretEntry] });
        }
        await expect(outcome).resolves.toEqual({ error: new Error("run stopped during metadata") });
      } finally {
        controller.abort();
        metadata.resolve({ entries: [secretEntry] });
        await outcome;
      }
    },
  );

  it("cancels a registered credential request when its agent run aborts", async () => {
    const controller = new AbortController();
    const gateway = gatewayStub(async (method, _options, params, extra) => {
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
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      if (method === "secrets.store.list") {
        return { entries: [unrelatedEnv, secretEntry] };
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

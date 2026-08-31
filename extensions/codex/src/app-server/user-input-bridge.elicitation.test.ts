// Codex tests retain only native envelope, extension, queue, and lifecycle behavior.
import {
  claimPendingAgentQuestionAnswer,
  type AgentHarnessQuestionGatewayCall,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { isJsonObject } from "./protocol.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { createCodexUserInputTestParams as createParams } from "./user-input-bridge.test-support.js";

type GatewayCallRecord = { method: string; params: unknown };

function formParams(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "forms",
    mode: "form",
    message: "Complete the profile",
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string", title: "Name" } },
      required: ["name"],
    },
    ...overrides,
  };
}

function createBridge(options: {
  params?: EmbeddedRunAttemptParams;
  signal?: AbortSignal;
  gatewayCall: AgentHarnessQuestionGatewayCall;
}) {
  return createCodexUserInputBridge({
    paramsForRun: options.params ?? createParams(),
    threadId: "thread-1",
    turnId: "turn-1",
    signal: options.signal,
    gatewayCall: options.gatewayCall,
  });
}

function createAnsweringGateway(answerBatches: Array<Record<string, string[]>>) {
  const calls: GatewayCallRecord[] = [];
  let answerIndex = 0;
  const call: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
    calls.push({ method, params });
    if (method === "question.request") {
      return { id: requireQuestionId(params) };
    }
    if (method === "question.waitAnswer") {
      const answers = answerBatches[answerIndex++];
      if (!answers) {
        throw new Error("missing gateway answer batch");
      }
      return { status: "answered", answers: { answers } };
    }
    return { status: "cancelled" };
  };
  return { call, calls };
}

function createControlledGateway() {
  const calls: GatewayCallRecord[] = [];
  const waits = new Map<string, (value: unknown) => void>();
  const call: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
    calls.push({ method, params });
    const questionId = requireQuestionId(params);
    if (method === "question.request") {
      return { id: questionId };
    }
    if (method === "question.waitAnswer") {
      return await new Promise((resolve) => {
        waits.set(questionId, resolve);
      });
    }
    if (method === "question.resolve") {
      waits.get(questionId)?.({ status: "cancelled" });
      return { status: "cancelled" };
    }
    throw new Error(`unexpected gateway method ${method}`);
  };
  return {
    call,
    calls,
    answer(questionId: string, answers: Record<string, string[]>) {
      waits.get(questionId)?.({ status: "answered", answers: { answers } });
    },
  };
}

function requireQuestionId(value: unknown): string {
  if (!isJsonObject(value) || typeof value.id !== "string") {
    throw new Error("expected Gateway question id");
  }
  return value.id;
}

function requestedQuestions(calls: GatewayCallRecord[]) {
  return calls
    .filter((entry) => entry.method === "question.request")
    .map((entry) => {
      if (!isJsonObject(entry.params) || !Array.isArray(entry.params.questions)) {
        throw new Error("expected Gateway question request");
      }
      return {
        id: requireQuestionId(entry.params),
        questions: entry.params.questions,
      };
    });
}

describe("Codex ordinary MCP elicitation adapter", () => {
  it("enables imagePicker only for negotiated openai/form input", async () => {
    const schema = {
      type: "object",
      properties: {
        template: {
          type: "openai/imagePicker",
          items: [{ id: "monthly", title: "Monthly review", image: "https://invalid/unused" }],
        },
      },
      required: ["template"],
    };
    const standardParams = createParams();
    const standardGateway = createAnsweringGateway([]);
    const standard = createBridge({ params: standardParams, gatewayCall: standardGateway.call });
    await expect(
      standard.handleElicitationRequest({
        id: "standard-image",
        params: formParams({ requestedSchema: schema }),
      }),
    ).resolves.toMatchObject({
      action: "decline",
      _meta: { message: expect.stringContaining("unsupported") },
    });
    expect(standardGateway.calls).toEqual([]);

    const extendedGateway = createAnsweringGateway([{ template: ["Monthly review"] }]);
    const extended = createBridge({ gatewayCall: extendedGateway.call });
    await expect(
      extended.handleElicitationRequest({
        id: 41,
        params: formParams({ mode: "openai/form", requestedSchema: schema }),
      }),
    ).resolves.toEqual({ action: "accept", content: { template: "monthly" }, _meta: null });
  });

  it("uses only direct isSecret metadata and never persists that field in Gateway questions", async () => {
    const params = createParams();
    const gateway = createAnsweringGateway([{ password: ["public-value"] }]);
    const bridge = createBridge({ params, gatewayCall: gateway.call });
    const response = bridge.handleElicitationRequest({
      id: "secret-metadata",
      params: formParams({
        requestedSchema: {
          type: "object",
          properties: {
            password: { type: "string" },
            token: { type: "string", isSecret: true },
          },
          required: ["password", "token"],
        },
      }),
    });
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(params.onBlockReply!)
          .mock.calls.some(([payload]) => payload.text?.includes("may show your reply")),
      ).toBe(true),
    );
    await expect(
      claimPendingAgentQuestionAnswer({ sessionKey: params.sessionKey, text: "private-value" }),
    ).resolves.toBe(true);
    await expect(response).resolves.toEqual({
      action: "accept",
      content: { password: "public-value", token: "private-value" },
      _meta: null,
    });
    expect(JSON.stringify(requestedQuestions(gateway.calls))).not.toContain("token");
  });

  it("compiles a queued request before caller mutation and preserves FIFO", async () => {
    const gateway = createControlledGateway();
    const bridge = createBridge({ gatewayCall: gateway.call });
    const first = bridge.handleElicitationRequest({ id: "first", params: formParams() });
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(1));

    const raw = formParams();
    const second = bridge.handleElicitationRequest({ id: "second", params: raw });
    (raw.requestedSchema.properties.name as { type: string }).type = "integer";

    bridge.handleNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "first" },
    });
    await expect(first).resolves.toEqual({ action: "cancel", content: null, _meta: null });
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(2));
    await vi.waitFor(() =>
      expect(gateway.calls.filter((entry) => entry.method === "question.waitAnswer")).toHaveLength(
        2,
      ),
    );
    const queued = requestedQuestions(gateway.calls)[1]!;
    gateway.answer(queued.id, { name: ["Grace"] });
    await expect(second).resolves.toEqual({
      action: "accept",
      content: { name: "Grace" },
      _meta: null,
    });
  });

  it("preserves exact string-versus-integer request ids when cancelling", async () => {
    const gateway = createControlledGateway();
    const bridge = createBridge({ gatewayCall: gateway.call });
    const integerRequest = bridge.handleElicitationRequest({ id: 7, params: formParams() });
    const stringRequest = bridge.handleElicitationRequest({ id: "7", params: formParams() });
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(1));

    bridge.handleNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 7 },
    });
    await expect(integerRequest).resolves.toMatchObject({ action: "cancel" });
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(2));
    await vi.waitFor(() =>
      expect(gateway.calls.filter((entry) => entry.method === "question.waitAnswer")).toHaveLength(
        2,
      ),
    );

    bridge.handleNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 7 },
    });
    const current = requestedQuestions(gateway.calls)[1]!;
    gateway.answer(current.id, { name: ["Ada"] });
    await expect(stringRequest).resolves.toMatchObject({ action: "accept" });
  });

  it("cancels an exact queued request without disturbing the active request", async () => {
    const gateway = createControlledGateway();
    const bridge = createBridge({ gatewayCall: gateway.call });
    const active = bridge.handleElicitationRequest({ id: "active", params: formParams() });
    const queued = bridge.handleElicitationRequest({ id: "queued", params: formParams() });
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(1));
    bridge.handleNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "queued" },
    });
    await expect(queued).resolves.toMatchObject({ action: "cancel" });
    await vi.waitFor(() =>
      expect(gateway.calls.filter((entry) => entry.method === "question.waitAnswer")).toHaveLength(
        1,
      ),
    );
    const current = requestedQuestions(gateway.calls)[0]!;
    gateway.answer(current.id, { name: ["Ada"] });
    await expect(active).resolves.toMatchObject({ action: "accept" });
  });

  it("lets lifecycle cancellation fence a late committed answer", async () => {
    let answer!: (value: unknown) => void;
    const wait = new Promise<unknown>((resolve) => {
      answer = resolve;
    });
    const calls: GatewayCallRecord[] = [];
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
      calls.push({ method, params });
      if (method === "question.request") {
        return { id: requireQuestionId(params) };
      }
      if (method === "question.waitAnswer") {
        return await wait;
      }
      return { status: "cancelled" };
    };
    const bridge = createBridge({ gatewayCall });
    const response = bridge.handleElicitationRequest({ id: "late", params: formParams() });
    await vi.waitFor(() => expect(requestedQuestions(calls)).toHaveLength(1));
    bridge.handleNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "late" },
    });
    answer({ status: "answered", answers: { answers: { name: ["too late"] } } });
    await expect(response).resolves.toEqual({ action: "cancel", content: null, _meta: null });
  });

  it("recognizes form, openai/form, URL, nullable turn, and exact scope envelopes", async () => {
    const gateway = createAnsweringGateway([{ name: ["Ada"] }, { continue: ["Continue"] }]);
    const bridge = createBridge({ gatewayCall: gateway.call });
    await expect(
      bridge.handleElicitationRequest({ id: "nullable", params: formParams({ turnId: null }) }),
    ).resolves.toEqual({ action: "accept", content: { name: "Ada" }, _meta: null });
    await expect(
      bridge.handleElicitationRequest({
        id: "url",
        params: formParams({
          mode: "url",
          requestedSchema: undefined,
          url: "https://example.com/authorize",
          elicitationId: "auth-1",
        }),
      }),
    ).resolves.toEqual({ action: "accept", content: null, _meta: null });
    await expect(
      bridge.handleElicitationRequest({
        id: "wrong-turn",
        params: formParams({ turnId: "other" }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      bridge.handleElicitationRequest({
        id: "wrong-thread",
        params: formParams({ threadId: "other" }),
      }),
    ).resolves.toBeUndefined();
  });
});

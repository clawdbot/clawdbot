import type { AcpElicitationRequest } from "@openclaw/acp-core/runtime/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimPendingAgentQuestionAnswer } from "../../agents/harness/gateway-question.js";

const gatewayCallMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool: gatewayCallMock }));

import { createAcpElicitationHandler } from "./acp-elicitation-handler.js";

type GatewayQuestion = { questionId: string; options?: Array<{ label: string }> };
type GatewayRequest = {
  id: string;
  questions: GatewayQuestion[];
  sessionKey?: string;
  runId?: string;
};

function formRequest(
  properties: Record<string, unknown>,
  required: string[] = [],
): AcpElicitationRequest {
  return {
    mode: "form",
    sessionId: "acp-session",
    toolCallId: "tool-call",
    message: "ACP needs input",
    requestedSchema: { type: "object", properties, required },
  } as AcpElicitationRequest;
}

function urlRequest(overrides: Partial<Record<string, unknown>> = {}): AcpElicitationRequest {
  return {
    mode: "url",
    sessionId: "acp-session",
    toolCallId: "tool-call",
    message: "Authenticate",
    elicitationId: "login-1",
    url: "https://example.com/login",
    ...overrides,
  } as AcpElicitationRequest;
}

function createFixture() {
  const delivered: string[] = [];
  let active = true;
  const handler = createAcpElicitationHandler({
    sourceSessionKey: "agent:main:source",
    targetSessionKey: "agent:codex:acp:target",
    outerRequestId: "outer-turn",
    agentId: "main",
    runId: "run-1",
    delivery: {
      deliver: vi.fn(async (_kind, payload) => {
        if (payload.text) {
          delivered.push(payload.text);
        }
        return true;
      }),
    },
    isActive: () => active,
  });
  return {
    delivered,
    handler,
    deactivate: () => {
      active = false;
    },
  };
}

function answerGateway(
  answer: (questions: GatewayQuestion[]) => Record<string, string[]>,
): GatewayRequest[] {
  const requests = new Map<string, GatewayRequest>();
  const ordered: GatewayRequest[] = [];
  gatewayCallMock.mockImplementation(async (method: string, _opts: unknown, rawParams: unknown) => {
    const params = rawParams as GatewayRequest;
    if (method === "question.request") {
      requests.set(params.id, params);
      ordered.push(params);
      return { id: params.id };
    }
    if (method === "question.waitAnswer") {
      const request = requests.get(params.id);
      if (!request) {
        throw new Error("missing question registration");
      }
      return { status: "answered", answers: { answers: answer(request.questions) } };
    }
    if (method === "question.resolve") {
      return { status: "cancelled" };
    }
    throw new Error(`unexpected gateway method ${method}`);
  });
  return ordered;
}

describe("ACP elicitation delivery", () => {
  beforeEach(() => {
    gatewayCallMock.mockReset();
  });

  it("rejects accessor-backed request objects without invoking the accessor", async () => {
    let reads = 0;
    const request = Object.defineProperty(
      {
        mode: "form",
        sessionId: "acp-session",
        message: "Input",
      },
      "requestedSchema",
      {
        enumerable: true,
        get() {
          reads += 1;
          return { type: "object", properties: { value: { type: "string" } } };
        },
      },
    ) as AcpElicitationRequest;
    const { delivered, handler } = createFixture();

    const response = await handler(request, {
      requestId: "accessor",
      signal: new AbortController().signal,
    });

    expect(response.action).toBe("decline");
    expect(reads).toBe(0);
    expect(delivered.join("\n")).toContain("malformed");
  });

  it("uses outer, scope, session, and tool-call correlation in Gateway records", async () => {
    const requests = answerGateway((questions) => ({ [questions[0]!.questionId]: ["Continue"] }));
    const { handler } = createFixture();

    await handler(urlRequest(), {
      requestId: 1,
      signal: new AbortController().signal,
    });
    await handler(
      {
        mode: "url",
        requestId: "auth-request",
        message: "Authenticate",
        elicitationId: "login-2",
        url: "https://example.com/login",
      },
      { requestId: 2, signal: new AbortController().signal },
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.id).toMatch(/^acp_[a-f0-9]{24}_0$/u);
    expect(requests[1]?.id).toMatch(/^acp_[a-f0-9]{24}_0$/u);
    expect(requests[0]?.id).not.toBe(requests[1]?.id);
    expect(requests[0]).toMatchObject({
      sessionKey: "agent:codex:acp:target",
      runId: "run-1",
    });
  });

  it("cancels an aborted request and rejects a late Gateway answer", async () => {
    let registered = false;
    gatewayCallMock.mockImplementation(
      async (
        method: string,
        _opts: unknown,
        rawParams: unknown,
        extra?: { signal?: AbortSignal },
      ) => {
        if (method === "question.request") {
          registered = true;
          return { id: (rawParams as { id: string }).id };
        }
        if (method === "question.waitAnswer") {
          return await new Promise((_, reject) => {
            extra?.signal?.addEventListener("abort", () => reject(new Error("late answer")), {
              once: true,
            });
          });
        }
        return { status: "cancelled" };
      },
    );
    const controller = new AbortController();
    const { handler } = createFixture();
    const response = handler(urlRequest(), { requestId: "abort", signal: controller.signal });
    await vi.waitFor(() => expect(registered).toBe(true));

    controller.abort();

    await expect(response).resolves.toMatchObject({ action: "cancel" });
  });

  it("keeps explicitly marked Codex secrets out of Gateway question records", async () => {
    gatewayCallMock.mockRejectedValue(new Error("secret must not reach Gateway questions"));
    const { delivered, handler } = createFixture();
    const response = handler(
      formRequest(
        {
          token: {
            type: "string",
            title: "Token",
            _meta: { codex: { isSecret: true } },
          },
        },
        ["token"],
      ),
      { requestId: "secret", signal: new AbortController().signal },
    );
    await vi.waitFor(() => expect(delivered.join("\n")).toContain("may show your reply"));

    await expect(
      claimPendingAgentQuestionAnswer({
        sessionKey: "agent:codex:acp:target",
        text: "private-value",
      }),
    ).resolves.toBe(true);

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { token: "private-value" },
    });
    expect(gatewayCallMock).not.toHaveBeenCalled();
  });

  it("accepts an ACP form elicitation with an empty schema instead of declining it", async () => {
    const { handler } = createFixture();

    const response = handler(formRequest({}), {
      requestId: "empty-form",
      signal: new AbortController().signal,
    });

    await expect(response).resolves.toEqual({
      action: "accept",
      content: {},
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  claimPendingAgentQuestionAnswer,
  type AgentHarnessQuestionGatewayCall,
} from "./gateway-question.js";
import { runStructuredInput } from "./structured-input-execution.js";
import {
  compileStructuredInputForm,
  compileStructuredInputUrl,
  snapshotStructuredInput,
} from "./structured-input.js";

type GatewayQuestion = { questionId: string };
type GatewayRequest = { id: string; questions: GatewayQuestion[] };

function compileForm(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return compileStructuredInputForm({
    schema: snapshotStructuredInput({ type: "object", properties, required }),
    message: "Complete the form",
    fallbackMessage: "Input requested",
    options: {
      protocolName: "test",
      minimumChoiceCount: 1,
      metadata: { secretPath: ["isSecret"] },
    },
  });
}

function createGateway(answer: (questions: GatewayQuestion[]) => Record<string, string[]>) {
  const requests = new Map<string, GatewayRequest>();
  const requested: GatewayRequest[] = [];
  const call: AgentHarnessQuestionGatewayCall = vi.fn(async (method, _opts, rawParams) => {
    const params = rawParams as GatewayRequest;
    if (method === "question.request") {
      requests.set(params.id, params);
      requested.push(params);
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
  return { call, requested };
}

function executionParams(gatewayCall: AgentHarnessQuestionGatewayCall) {
  const onBlockReply = vi.fn(async (_payload: { text?: string }) => undefined);
  return {
    sessionKey: "agent:main:structured-input",
    agentId: "main",
    runId: "run-1",
    timeoutMs: 90_000,
    gatewayCall,
    delivery: { onBlockReply },
  };
}

async function claimEventually(sessionKey: string, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await claimPendingAgentQuestionAnswer({ sessionKey, text })) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  return false;
}

describe("structured input execution", () => {
  it("batches ordinary questions by three and isolates secret input from Gateway records", async () => {
    const gateway = createGateway((questions) =>
      Object.fromEntries(questions.map((question) => [question.questionId, [question.questionId]])),
    );
    const input = compileForm({
      a: { type: "string" },
      b: { type: "string" },
      c: { type: "string" },
      token: { type: "string", isSecret: true },
      d: { type: "string" },
      e: { type: "string" },
      f: { type: "string" },
      g: { type: "string" },
    });
    const params = executionParams(gateway.call);
    const result = runStructuredInput({ input, ...params });

    await vi.waitFor(() =>
      expect(
        vi
          .mocked(params.delivery.onBlockReply)
          .mock.calls.some(([payload]) => payload.text?.includes("may show your reply")),
      ).toBe(true),
    );
    await expect(claimEventually(params.sessionKey, "private-value")).resolves.toBe(true);

    await expect(result).resolves.toEqual({
      status: "answered",
      answers: {
        a: ["a"],
        b: ["b"],
        c: ["c"],
        token: ["private-value"],
        d: ["d"],
        e: ["e"],
        f: ["f"],
        g: ["g"],
      },
      content: {
        a: "a",
        b: "b",
        c: "c",
        token: "private-value",
        d: "d",
        e: "e",
        f: "f",
        g: "g",
      },
    });
    expect(gateway.requested.map((request) => request.questions.length)).toEqual([3, 3, 1]);
    expect(gateway.requested.flatMap((request) => request.questions)).not.toContainEqual({
      questionId: "token",
    });
  });

  it("delivers a visible unsupported outcome without creating a Gateway record", async () => {
    const gatewayCall = vi.fn<AgentHarnessQuestionGatewayCall>();
    const params = executionParams(gatewayCall);
    const result = await runStructuredInput({
      input: { kind: "unsupported", message: "Unsupported nested object field." },
      ...params,
    });

    expect(result).toEqual({
      status: "unsupported",
      message: "Unsupported nested object field.",
    });
    expect(params.delivery.onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Unsupported nested object field") }),
    );
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it.each([
    ["Continue", "answered"],
    ["Decline", "declined"],
  ] as const)("maps the URL choice %s to %s", async (choice, status) => {
    const gateway = createGateway((questions) => ({ [questions[0]!.questionId]: [choice] }));
    const input = compileStructuredInputUrl({
      url: "https://example.com/authorize",
      elicitationId: "auth-1",
      message: "Review authorization",
      fallbackMessage: "Review URL",
      protocolName: "test",
    });

    await expect(
      runStructuredInput({ input, ...executionParams(gateway.call) }),
    ).resolves.toMatchObject({
      status,
    });
  });

  it("declines decoded values outside the compiled constraint and shows the reason", async () => {
    const gateway = createGateway((questions) => ({ [questions[0]!.questionId]: ["12"] }));
    const params = executionParams(gateway.call);
    const input = compileForm({ count: { type: "integer", minimum: 1, maximum: 9 } });

    const result = await runStructuredInput({ input, ...params });

    expect(result).toMatchObject({
      status: "declined",
      message: expect.stringContaining("at most 9"),
    });
    expect(params.delivery.onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("at most 9") }),
    );
  });

  it("fences an answer when the owning turn becomes inactive before commit", async () => {
    let settle!: (value: unknown) => void;
    const wait = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const gatewayCallMock = vi.fn(async (method: string, _opts: unknown, params: unknown) => {
      if (method === "question.request") {
        return { id: (params as { id: string }).id };
      }
      if (method === "question.waitAnswer") {
        return await wait;
      }
      return { status: "cancelled" };
    });
    const gatewayCall: AgentHarnessQuestionGatewayCall = gatewayCallMock;
    let active = true;
    const result = runStructuredInput({
      input: compileForm({ name: { type: "string" } }),
      ...executionParams(gatewayCall),
      isActive: () => active,
    });
    await vi.waitFor(() =>
      expect(gatewayCallMock.mock.calls.some(([method]) => method === "question.waitAnswer")).toBe(
        true,
      ),
    );

    active = false;
    settle({ status: "answered", answers: { answers: { name: ["too late"] } } });

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
  });
});

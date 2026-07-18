// Codex tests cover protocol validators plugin behavior.
import { describe, expect, it } from "vitest";
import {
  readCodexModelListResponse,
  readCodexTurn,
  assertCodexThreadStartResponse,
  assertCodexThreadResumeResponse,
} from "./protocol-validators.js";

function makeMinimalThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-1",
    sessionId: "session-1",
    cliVersion: "0.129.0",
    createdAt: 1715299200,
    updatedAt: 1715299200,
    cwd: "/tmp",
    ephemeral: false,
    modelProvider: "openai",
    preview: "test thread",
    source: "appServer",
    status: { type: "notLoaded" },
    turns: [],
    ...overrides,
  };
}

function makeMinimalResponse(threadOverrides: Record<string, unknown> = {}) {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp",
    model: "gpt-5.4",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: makeMinimalThread(threadOverrides),
  };
}

describe("Codex thread response validators", () => {
  // The 0.143 floor guarantees both thread ids; pre-0.131 servers without
  // sessionId must fail loudly instead of being silently normalized.
  it("rejects thread responses missing sessionId", () => {
    for (const assertResponse of [
      assertCodexThreadStartResponse,
      assertCodexThreadResumeResponse,
    ]) {
      const response = makeMinimalResponse({ sessionId: undefined });
      delete (response.thread as Record<string, unknown>).sessionId;
      expect(() => assertResponse(response)).toThrow("Invalid Codex app-server");
    }
  });
});

describe("assertCodexThreadStartResponse", () => {
  it("accepts response with both id and sessionId", () => {
    const response = makeMinimalResponse();
    const result = assertCodexThreadStartResponse(response);
    expect(result.thread.id).toBe("thread-1");
    expect(result.thread.sessionId).toBe("session-1");
    expect(result.thread.historyMode).toBe("legacy");
  });

  it("throws on invalid response", () => {
    expect(() => assertCodexThreadStartResponse({})).toThrow("Invalid Codex app-server");
  });
});

describe("assertCodexThreadResumeResponse", () => {
  it("accepts the bounded initial turns page shipped by the managed Codex version", () => {
    const result = assertCodexThreadResumeResponse({
      ...makeMinimalResponse(),
      initialTurnsPage: {
        data: [{ id: "turn-running", items: [], status: "inProgress" }],
        nextCursor: null,
        backwardsCursor: "resume-anchor",
      },
    });

    expect(result.thread.turns).toEqual([]);
    expect(result.initialTurnsPage?.data).toEqual([
      { id: "turn-running", items: [], status: "inProgress" },
    ]);
  });
});

describe("readCodexModelListResponse", () => {
  it("applies defaults from generated schemas behind local refs", () => {
    const response = readCodexModelListResponse({
      data: [
        {
          id: "gpt-test",
          model: "gpt-test",
          displayName: "GPT Test",
          description: "test model",
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [],
        },
      ],
    });

    const model = response?.data[0] as
      | (NonNullable<ReturnType<typeof readCodexModelListResponse>>["data"][number] & {
          serviceTiers?: unknown;
          supportsPersonality?: unknown;
        })
      | undefined;
    expect(model?.inputModalities).toEqual(["text", "image"]);
    expect(model?.serviceTiers).toEqual([]);
    expect(model?.supportsPersonality).toBe(false);
  });
});

describe("readCodexTurn", () => {
  it("does not merge defaults from unrelated thread item union branches", () => {
    const turn = readCodexTurn({
      id: "turn-1",
      status: "completed",
      items: [{ id: "item-1", type: "plan", text: "ship it" }],
    });

    expect(turn?.items[0]).toEqual({ id: "item-1", type: "plan", text: "ship it" });
  });

  it("accepts nullable arrays in generated dynamic tool call items", () => {
    const turn = readCodexTurn({
      id: "turn-1",
      status: "completed",
      items: [
        {
          arguments: {},
          contentItems: null,
          id: "item-1",
          status: "completed",
          tool: "render",
          type: "dynamicToolCall",
        },
      ],
    });

    expect(turn?.items[0]).toMatchObject({
      contentItems: null,
      id: "item-1",
      type: "dynamicToolCall",
    });
  });
});

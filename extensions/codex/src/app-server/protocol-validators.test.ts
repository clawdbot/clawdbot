// Codex tests cover protocol validators plugin behavior.
import { describe, expect, it } from "vitest";
import {
  assertCodexModelListResponse,
  assertCodexThreadForkParams,
  readCodexTurn,
  assertCodexThreadStartResponse,
  assertCodexThreadResumeResponse,
} from "./protocol-validators.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

function makeMinimalThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-1",
    sessionId: "session-1",
    cliVersion: CODEX_APP_SERVER_VERSION,
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
  // The pinned Codex protocol requires both thread identities; never silently
  // invent a session identity when a malformed response omits one.
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

describe("assertCodexThreadForkParams", () => {
  it("accepts the experimental beforeTurnId boundary", () => {
    expect(
      assertCodexThreadForkParams({
        threadId: "thread-1",
        beforeTurnId: "turn-2",
        excludeTurns: true,
      }),
    ).toMatchObject({ beforeTurnId: "turn-2" });
  });

  it("rejects a non-string beforeTurnId", () => {
    expect(() => assertCodexThreadForkParams({ threadId: "thread-1", beforeTurnId: 2 })).toThrow(
      "Invalid Codex app-server thread/fork params",
    );
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

describe("assertCodexModelListResponse", () => {
  it.each([
    { label: "missing response", value: undefined },
    { label: "null response", value: null },
    { label: "missing model data", value: {} },
    { label: "non-array model data", value: { data: {} } },
    { label: "null model row", value: { data: [null] } },
    { label: "invalid pagination cursor", value: { data: [], nextCursor: 42 } },
  ])("rejects $label", ({ value }) => {
    expect(() => assertCodexModelListResponse(value)).toThrow(
      /Invalid Codex app-server model\/list response/,
    );
  });

  it.each([{ data: [] }, { data: [], nextCursor: null }])(
    "accepts a genuinely empty model catalog",
    (value) => {
      expect(assertCodexModelListResponse(value)).toMatchObject({ data: [] });
    },
  );

  it("applies defaults from generated schemas behind local refs", () => {
    const response = assertCodexModelListResponse({
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

    const model = response.data[0] as
      | (ReturnType<typeof assertCodexModelListResponse>["data"][number] & {
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

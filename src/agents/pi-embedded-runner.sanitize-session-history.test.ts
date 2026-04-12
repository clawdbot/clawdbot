import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, UserMessage, Usage } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectOpenAIResponsesStrictSanitizeCall,
  loadSanitizeSessionHistoryWithCleanMocks,
  makeMockSessionManager,
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
  makeReasoningAssistantMessages,
  makeSimpleUserMessages,
  sanitizeSnapshotChangedOpenAIReasoning,
  type SanitizeSessionHistoryHarness,
  type SanitizeSessionHistoryFn,
  sanitizeWithOpenAIResponses,
  TEST_SESSION_ID,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";
import { validateReplayTurns } from "./pi-embedded-runner/replay-history.js";
import { castAgentMessage, castAgentMessages } from "./test-helpers/agent-message-fixtures.js";
import { extractToolCallsFromAssistant } from "./tool-call-id.js";
import type { TranscriptPolicy } from "./transcript-policy.js";
import { makeZeroUsageSnapshot } from "./usage.js";

vi.mock("./pi-embedded-helpers.js", async () => ({
  ...(await vi.importActual("./pi-embedded-helpers.js")),
  isGoogleModelApi: vi.fn(),
  sanitizeSessionMessagesImages: vi.fn(async (msgs) => msgs),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderRuntimePlugin: ({ provider }: { provider?: string }) =>
      provider === "openrouter" || provider === "github-copilot"
        ? {
            buildReplayPolicy: (context?: { modelId?: string | null }) => {
              const modelId = (context?.modelId ?? "").toLowerCase();
              if (provider === "openrouter") {
                return {
                  applyAssistantFirstOrderingFix: false,
                  validateGeminiTurns: false,
                  validateAnthropicTurns: false,
                  ...(modelId.includes("gemini")
                    ? {
                        sanitizeThoughtSignatures: {
                          allowBase64Only: true,
                          includeCamelCase: true,
                        },
                      }
                    : {}),
                };
              }
              if (provider === "github-copilot" && modelId.includes("claude")) {
                return {
                  dropThinkingBlocks: true,
                };
              }
              return undefined;
            },
          }
        : undefined,
    sanitizeProviderReplayHistoryWithPlugin: vi.fn(
      async ({
        provider,
        context,
      }: {
        provider?: string;
        context: {
          messages: AgentMessage[];
          sessionState?: {
            appendCustomEntry(customType: string, data: unknown): void;
          };
        };
      }) => {
        if (
          provider &&
          provider.startsWith("google") &&
          context.messages[0]?.role === "assistant" &&
          context.sessionState
        ) {
          context.sessionState.appendCustomEntry("google-turn-ordering-bootstrap", {
            timestamp: Date.now(),
          });
          return [
            { role: "user", content: "(session bootstrap)" } as AgentMessage,
            ...context.messages,
          ];
        }
        return context.messages;
      },
    ),
    validateProviderReplayTurnsWithPlugin: vi.fn(() => undefined),
  };
});

let sanitizeSessionHistory: SanitizeSessionHistoryFn;
let mockedHelpers: SanitizeSessionHistoryHarness["mockedHelpers"];
let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

// We don't mock session-transcript-repair.js as it is a pure function and complicates mocking.
// We rely on the real implementation which should pass through our simple messages.

describe("sanitizeSessionHistory", () => {
  let mockSessionManager: ReturnType<typeof makeMockSessionManager>;
  const mockMessages = makeSimpleUserMessages();
  const setNonGoogleModelApi = () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);
  };

  const sanitizeGithubCopilotHistory = async (params: {
    messages: AgentMessage[];
    modelApi?: string;
    modelId?: string;
  }) =>
    sanitizeSessionHistory({
      messages: params.messages,
      modelApi: params.modelApi ?? "openai-completions",
      provider: "github-copilot",
      modelId: params.modelId ?? "claude-opus-4.6",
      sessionManager: makeMockSessionManager(),
      sessionId: TEST_SESSION_ID,
    });

  const sanitizeAnthropicHistory = async (params: {
    messages: AgentMessage[];
    provider?: string;
    modelApi?: string;
    modelId?: string;
    policy?: TranscriptPolicy;
  }) =>
    sanitizeSessionHistory({
      messages: params.messages,
      modelApi: params.modelApi ?? "anthropic-messages",
      provider: params.provider ?? "anthropic",
      modelId: params.modelId ?? "claude-opus-4-6",
      sessionManager: makeMockSessionManager(),
      sessionId: TEST_SESSION_ID,
      policy: params.policy,
    });

  const getAssistantMessage = (messages: AgentMessage[]) => {
    expect(messages[1]?.role).toBe("assistant");
    return messages[1] as Extract<AgentMessage, { role: "assistant" }>;
  };

  const getAssistantContentTypes = (messages: AgentMessage[]) =>
    getAssistantMessage(messages).content.map((block: { type: string }) => block.type);

  const makeThinkingAndTextAssistantMessages = (
    thinkingSignature: string = "some_sig",
  ): AgentMessage[] => {
    const user: UserMessage = {
      role: "user",
      content: "hello",
      timestamp: nextTimestamp(),
    };
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "internal",
          thinkingSignature,
        },
        { type: "text", text: "hi" },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: makeUsage(0, 0, 0),
      stopReason: "stop",
      timestamp: nextTimestamp(),
    };
    return [user, assistant];
  };

  const makeUsage = (input: number, output: number, totalTokens: number): Usage => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  const makeAssistantUsageMessage = (params: {
    text: string;
    usage: ReturnType<typeof makeUsage>;
    timestamp?: number;
  }): AssistantMessage => ({
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    stopReason: "stop",
    timestamp: params.timestamp ?? nextTimestamp(),
    usage: params.usage,
  });

  const makeUserMessage = (content: string, timestamp = nextTimestamp()): UserMessage => ({
    role: "user",
    content,
    timestamp,
  });

  const makeAssistantMessage = (
    content: AssistantMessage["content"],
    params: {
      stopReason?: AssistantMessage["stopReason"];
      usage?: Usage;
      timestamp?: number;
    } = {},
  ): AssistantMessage => ({
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: params.usage ?? makeUsage(0, 0, 0),
    stopReason: params.stopReason ?? "stop",
    timestamp: params.timestamp ?? nextTimestamp(),
  });

  const makeCompactionSummaryMessage = (tokensBefore: number, timestamp: string) =>
    castAgentMessage({
      role: "compactionSummary",
      summary: "compressed",
      tokensBefore,
      timestamp,
    });

  const sanitizeOpenAIHistory = async (
    messages: AgentMessage[],
    overrides: Partial<Parameters<SanitizeSessionHistoryFn>[0]> = {},
  ) =>
    sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
      ...overrides,
    });

  const getAssistantMessages = (messages: AgentMessage[]) =>
    messages.filter((message) => message.role === "assistant") as Array<
      AgentMessage & { usage?: unknown; content?: unknown }
    >;

  const getSingleAssistantUsage = async (messages: AgentMessage[]) => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);
    const result = await sanitizeOpenAIHistory(messages);
    return result.find((message) => message.role === "assistant") as
      | (AgentMessage & { usage?: unknown })
      | undefined;
  };

  beforeAll(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    sanitizeSessionHistory = harness.sanitizeSessionHistory;
    mockedHelpers = harness.mockedHelpers;
  });

  beforeEach(() => {
    testTimestamp = 1;
    vi.clearAllMocks();
    vi.mocked(mockedHelpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
    mockSessionManager = makeMockSessionManager();
  });

  it("passes simple user-only history through for Google model APIs", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(true);

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "google-generative-ai",
      provider: "google-vertex",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result).toEqual(mockMessages);
  });

  it("lets Google provider hooks prepend a bootstrap turn and persist a marker", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(true);
    const sessionEntries: Array<{ type: string; customType: string; data: unknown }> = [];
    const sessionManager = makeInMemorySessionManager(sessionEntries);

    const result = await sanitizeSessionHistory({
      messages: castAgentMessages([
        {
          role: "assistant",
          content: [{ type: "text", text: "hello from previous turn" }],
        },
      ]),
      modelApi: "google-generative-ai",
      provider: "google-vertex",
      sessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result[0]).toMatchObject({
      role: "user",
      content: "(session bootstrap)",
    });
    expect(
      sessionEntries.some((entry) => entry.customType === "google-turn-ordering-bootstrap"),
    ).toBe(true);
  });

  it("passes simple user-only history through for Mistral models", async () => {
    setNonGoogleModelApi();

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-responses",
      provider: "openrouter",
      modelId: "mistralai/devstral-2512:free",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result).toEqual(mockMessages);
  });

  it("passes simple user-only history through for Anthropic APIs", async () => {
    setNonGoogleModelApi();

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result).toEqual(mockMessages);
  });

  it("passes simple user-only history through for openai-responses", async () => {
    setNonGoogleModelApi();

    const result = await sanitizeWithOpenAIResponses({
      sanitizeSessionHistory,
      messages: mockMessages,
      sessionManager: mockSessionManager,
    });

    expect(result).toEqual(mockMessages);
  });

  it("sanitizes tool call ids for OpenAI-compatible responses providers", async () => {
    setNonGoogleModelApi();

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-responses",
      provider: "custom",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expectOpenAIResponsesStrictSanitizeCall(
      mockedHelpers.sanitizeSessionMessagesImages,
      mockMessages,
    );
  });

  it("sanitizes tool call ids for openai-completions", async () => {
    setNonGoogleModelApi();

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-completions",
      provider: "openai",
      modelId: "gpt-5.4",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result).toEqual(mockMessages);
  });

  it("prepends a bootstrap user turn for strict OpenAI-compatible assistant-first history", async () => {
    setNonGoogleModelApi();
    const sessionEntries: Array<{ type: string; customType: string; data: unknown }> = [];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from previous turn" }],
      },
    ]);

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-completions",
      provider: "vllm",
      modelId: "gemma-3-27b",
      sessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result[0]?.role).toBe("user");
    expect((result[0] as { content?: unknown } | undefined)?.content).toBe("(session bootstrap)");
    expect(result[1]?.role).toBe("assistant");
    expect(
      sessionEntries.some((entry) => entry.customType === "google-turn-ordering-bootstrap"),
    ).toBe(false);
  });

  it("annotates inter-session user messages before context sanitization", async () => {
    setNonGoogleModelApi();

    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: "forwarded instruction",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:req",
          sourceTool: "sessions_send",
        },
      }),
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    const first = result[0] as Extract<AgentMessage, { role: "user" }>;
    expect(first.role).toBe("user");
    expect(typeof first.content).toBe("string");
    expect(first.content as string).toContain("[Inter-session message]");
    expect(first.content as string).toContain("sourceSession=agent:main:req");
  });

  it("drops stale assistant usage snapshots kept before latest compaction summary", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);

    const messages = castAgentMessages([
      { role: "user", content: "old context" },
      makeAssistantUsageMessage({
        text: "old answer",
        usage: makeUsage(191_919, 2_000, 193_919),
      }),
      makeCompactionSummaryMessage(191_919, new Date().toISOString()),
    ]);

    const result = await sanitizeOpenAIHistory(messages);

    const staleAssistant = result.find((message) => message.role === "assistant") as
      | (AgentMessage & { usage?: unknown })
      | undefined;
    expect(staleAssistant).toBeDefined();
    expect(staleAssistant?.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("preserves fresh assistant usage snapshots created after latest compaction summary", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);

    const messages = castAgentMessages([
      makeAssistantUsageMessage({
        text: "pre-compaction answer",
        usage: makeUsage(120_000, 3_000, 123_000),
      }),
      makeCompactionSummaryMessage(123_000, new Date().toISOString()),
      { role: "user", content: "new question" },
      makeAssistantUsageMessage({
        text: "fresh answer",
        usage: makeUsage(1_000, 250, 1_250),
      }),
    ]);

    const result = await sanitizeOpenAIHistory(messages);

    const assistants = getAssistantMessages(result);
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.usage).toEqual(makeZeroUsageSnapshot());
    expect(assistants[1]?.usage).toBeDefined();
  });

  it("adds a zeroed assistant usage snapshot when usage is missing", async () => {
    const assistant = await getSingleAssistantUsage(
      castAgentMessages([
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer without usage" }],
        },
      ]),
    );

    expect(assistant?.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("normalizes mixed partial assistant usage fields to numeric totals", async () => {
    const assistant = await getSingleAssistantUsage(
      castAgentMessages([
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer with partial usage" }],
          usage: {
            output: 3,
            cache_read_input_tokens: 9,
          },
        },
      ]),
    );

    expect(assistant?.usage).toEqual({
      input: 0,
      output: 3,
      cacheRead: 9,
      cacheWrite: 0,
      totalTokens: 12,
    });
  });

  it("preserves existing usage cost while normalizing token fields", async () => {
    const assistant = await getSingleAssistantUsage(
      castAgentMessages([
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer with partial usage and cost" }],
          usage: {
            output: 3,
            cache_read_input_tokens: 9,
            cost: {
              input: 1.25,
              output: 2.5,
              cacheRead: 0.25,
              cacheWrite: 0,
              total: 4,
            },
          },
        },
      ]),
    );

    expect(assistant?.usage).toEqual({
      ...makeZeroUsageSnapshot(),
      input: 0,
      output: 3,
      cacheRead: 9,
      cacheWrite: 0,
      totalTokens: 12,
      cost: {
        input: 1.25,
        output: 2.5,
        cacheRead: 0.25,
        cacheWrite: 0,
        total: 4,
      },
    });
  });

  it("preserves unknown cost when token fields already match", async () => {
    const assistant = await getSingleAssistantUsage(
      castAgentMessages([
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer with complete numeric usage but no cost" }],
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 10,
          },
        },
      ]),
    );

    expect(assistant?.usage).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
    });
    expect((assistant?.usage as { cost?: unknown } | undefined)?.cost).toBeUndefined();
  });

  it("drops stale usage when compaction summary appears before kept assistant messages", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);

    const compactionTs = Date.parse("2026-02-26T12:00:00.000Z");
    const messages = castAgentMessages([
      makeCompactionSummaryMessage(191_919, new Date(compactionTs).toISOString()),
      makeAssistantUsageMessage({
        text: "kept pre-compaction answer",
        timestamp: compactionTs - 1_000,
        usage: makeUsage(191_919, 2_000, 193_919),
      }),
    ]);

    const result = await sanitizeOpenAIHistory(messages);

    const assistant = result.find((message) => message.role === "assistant") as
      | (AgentMessage & { usage?: unknown })
      | undefined;
    expect(assistant?.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("keeps fresh usage after compaction timestamp in summary-first ordering", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);

    const compactionTs = Date.parse("2026-02-26T12:00:00.000Z");
    const messages = castAgentMessages([
      makeCompactionSummaryMessage(123_000, new Date(compactionTs).toISOString()),
      makeAssistantUsageMessage({
        text: "kept pre-compaction answer",
        timestamp: compactionTs - 2_000,
        usage: makeUsage(120_000, 3_000, 123_000),
      }),
      { role: "user", content: "new question", timestamp: compactionTs + 1_000 },
      makeAssistantUsageMessage({
        text: "fresh answer",
        timestamp: compactionTs + 2_000,
        usage: makeUsage(1_000, 250, 1_250),
      }),
    ]);

    const result = await sanitizeOpenAIHistory(messages);

    const assistants = getAssistantMessages(result);
    const keptAssistant = assistants.find((message) =>
      JSON.stringify(message.content).includes("kept pre-compaction answer"),
    );
    const freshAssistant = assistants.find((message) =>
      JSON.stringify(message.content).includes("fresh answer"),
    );
    expect(keptAssistant?.usage).toEqual(makeZeroUsageSnapshot());
    expect(freshAssistant?.usage).toBeDefined();
  });

  it("keeps reasoning-only assistant messages for openai-responses", async () => {
    setNonGoogleModelApi();

    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage(
        [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: "sig",
          },
        ],
        { stopReason: "aborted" },
      ),
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("assistant");
  });

  it("synthesizes missing tool results for openai-responses after repair", async () => {
    const messages: AgentMessage[] = [
      makeAssistantMessage([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }], {
        stopReason: "toolUse",
      }),
    ];

    const result = await sanitizeOpenAIHistory(messages);

    // repairToolUseResultPairing now runs for all providers (including OpenAI)
    // to fix orphaned function_call_output items that OpenAI would reject.
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("assistant");
    expect(result[1]?.role).toBe("toolResult");
  });

  it.each([
    {
      name: "missing input or arguments",
      makeMessages: () =>
        castAgentMessages([
          castAgentMessage({
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "read" }],
          }),
          makeUserMessage("hello"),
        ]),
      overrides: { sessionId: "test-session" } as Partial<
        Parameters<typeof sanitizeOpenAIHistory>[1]
      >,
    },
    {
      name: "invalid or overlong names",
      makeMessages: () =>
        castAgentMessages([
          makeAssistantMessage(
            [
              {
                type: "toolCall",
                id: "call_bad",
                name: 'toolu_01mvznfebfuu <|tool_call_argument_begin|> {"command"',
                arguments: {},
              },
              {
                type: "toolCall",
                id: "call_long",
                name: `read_${"x".repeat(80)}`,
                arguments: {},
              },
            ],
            { stopReason: "toolUse" },
          ),
          makeUserMessage("hello"),
        ]),
      overrides: {} as Partial<Parameters<typeof sanitizeOpenAIHistory>[1]>,
    },
  ])("drops malformed tool calls: $name", async ({ makeMessages, overrides }) => {
    const result = await sanitizeOpenAIHistory(makeMessages(), overrides);
    expect(result.map((msg) => msg.role)).toEqual(["user"]);
  });

  it("drops tool calls that are not in the allowed tool set", async () => {
    const messages: AgentMessage[] = [
      makeAssistantMessage([{ type: "toolCall", id: "call_1", name: "write", arguments: {} }], {
        stopReason: "toolUse",
      }),
    ];

    const result = await sanitizeOpenAIHistory(messages, {
      allowedToolNames: ["read"],
    });

    expect(result).toEqual([]);
  });

  it("downgrades orphaned openai reasoning even when the model has not changed", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = makeReasoningAssistantMessages({ thinkingSignature: "json" });

    const result = await sanitizeWithOpenAIResponses({
      sanitizeSessionHistory,
      messages,
      modelId: "gpt-5.4",
      sessionManager,
    });

    expect(result).toEqual([]);
  });

  it("downgrades orphaned openai reasoning when the model changes too", async () => {
    const result = await sanitizeSnapshotChangedOpenAIReasoning({
      sanitizeSessionHistory,
    });

    expect(result).toEqual([]);
  });

  it("drops orphaned toolResult entries when switching from openai history to anthropic", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages: AgentMessage[] = [
      makeAssistantMessage([{ type: "toolCall", id: "tool_abc123", name: "read", arguments: {} }], {
        stopReason: "toolUse",
      }),
      {
        role: "toolResult",
        toolCallId: "tool_abc123",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: nextTimestamp(),
      },
      makeUserMessage("continue"),
      {
        role: "toolResult",
        toolCallId: "tool_01VihkDRptyLpX1ApUPe7ooU",
        toolName: "read",
        content: [{ type: "text", text: "stale result" }],
        isError: false,
        timestamp: nextTimestamp(),
      },
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      sessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result.map((msg) => msg.role)).toEqual(["assistant", "toolResult", "user"]);
    expect(
      result.some(
        (msg) =>
          msg.role === "toolResult" &&
          (msg as { toolCallId?: string }).toolCallId === "tool_01VihkDRptyLpX1ApUPe7ooU",
      ),
    ).toBe(false);
  });

  it("preserves signed thinking turns while repairing legacy tool-result pairing for anthropic", async () => {
    const sessionManager = makeMockSessionManager();
    const messages: AgentMessage[] = [
      makeUserMessage("Use the gateway"),
      makeAssistantMessage(
        [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolCall", id: "toolu_legacy", name: "gateway", arguments: {} },
        ],
        { stopReason: "toolUse" },
      ),
      {
        role: "toolResult",
        toolName: "gateway",
        content: [{ type: "text", text: "legacy tool output without a linked id" }],
        isError: false,
        timestamp: nextTimestamp(),
      } as AgentMessage,
      makeUserMessage("continue"),
    ];

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      sessionManager,
      sessionId: TEST_SESSION_ID,
    });
    const validated = await validateReplayTurns({
      messages: sanitized,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      sessionId: TEST_SESSION_ID,
    });

    expect(sanitized.map((msg) => msg.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(validated.map((msg) => msg.role)).toEqual(["user", "assistant", "toolResult", "user"]);

    const assistant = validated[1] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
      { type: "toolCall", id: "toolu_legacy", name: "gateway", arguments: {} },
    ]);

    const toolResult = validated[2] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.toolCallId).toBe("toolu_legacy");
    expect(toolResult.isError).toBe(true);
  });

  it("preserves latest assistant thinking blocks for github-copilot models", async () => {
    setNonGoogleModelApi();

    const messages = makeThinkingAndTextAssistantMessages("reasoning_text");

    const result = await sanitizeGithubCopilotHistory({ messages });
    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([
      {
        type: "thinking",
        thinking: "internal",
        thinkingSignature: "reasoning_text",
      },
      { type: "text", text: "hi" },
    ]);
  });

  it("preserves latest assistant turn when all content is thinking blocks (github-copilot)", async () => {
    setNonGoogleModelApi();

    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage([
        {
          type: "thinking",
          thinking: "some reasoning",
          thinkingSignature: "reasoning_text",
        },
      ]),
      makeUserMessage("follow up"),
    ];

    const result = await sanitizeGithubCopilotHistory({ messages });

    expect(result).toHaveLength(3);
    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([
      {
        type: "thinking",
        thinking: "some reasoning",
        thinkingSignature: "reasoning_text",
      },
    ]);
  });

  it("preserves thinking blocks alongside tool_use blocks in latest assistant message (github-copilot)", async () => {
    setNonGoogleModelApi();

    const messages: AgentMessage[] = [
      makeUserMessage("read a file"),
      makeAssistantMessage([
        {
          type: "thinking",
          thinking: "I should use the read tool",
          thinkingSignature: "reasoning_text",
        },
        { type: "toolCall", id: "tool_123", name: "read", arguments: { path: "/tmp/test" } },
        { type: "text", text: "Let me read that file." },
      ]),
    ];

    const result = await sanitizeGithubCopilotHistory({ messages });
    const types = getAssistantContentTypes(result);
    expect(types).toContain("thinking");
    expect(types).toContain("toolCall");
    expect(types).toContain("text");
  });

  it("preserves latest assistant thinking blocks for anthropic replay", async () => {
    setNonGoogleModelApi();

    const messages = makeThinkingAndTextAssistantMessages();

    const result = await sanitizeAnthropicHistory({ messages });

    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([
      {
        type: "thinking",
        thinking: "internal",
        thinkingSignature: "some_sig",
      },
      { type: "text", text: "hi" },
    ]);
  });

  it("uses immutable thinking replay for anthropic-compatible providers when policy preserves signatures", async () => {
    setNonGoogleModelApi();

    const messages = castAgentMessages([
      makeUserMessage("retry"),
      makeAssistantMessage([
        {
          type: "thinking",
          thinking: "internal",
          thinkingSignature: "sig_1",
        },
        { type: "toolCall", id: "call_1", name: " read ", arguments: {} },
      ] as unknown as AssistantMessage["content"]),
    ]);

    const result = await sanitizeAnthropicHistory({
      provider: "anthropic-vertex",
      messages,
      policy: {
        sanitizeMode: "full",
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        preserveNativeAnthropicToolUseIds: true,
        repairToolUseResultPairing: true,
        preserveSignatures: true,
        sanitizeThoughtSignatures: undefined,
        sanitizeThinkingSignatures: false,
        dropThinkingBlocks: false,
        applyGoogleTurnOrdering: false,
        validateGeminiTurns: false,
        validateAnthropicTurns: true,
        allowSyntheticToolResults: true,
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "user",
      content: "retry",
    });
  });

  it("uses immutable thinking replay for amazon-bedrock claude providers when policy preserves signatures", async () => {
    setNonGoogleModelApi();

    const messages = castAgentMessages([
      makeUserMessage("retry"),
      makeAssistantMessage([
        {
          type: "thinking",
          thinking: "internal",
          thinkingSignature: "sig_1",
        },
        { type: "toolCall", id: "call_1", name: " read ", arguments: {} },
      ] as unknown as AssistantMessage["content"]),
    ]);

    const result = await sanitizeAnthropicHistory({
      provider: "amazon-bedrock",
      modelApi: "bedrock-converse-stream",
      messages,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "user",
      content: "retry",
    });
  });

  it.each([
    {
      provider: "anthropic",
      modelApi: "anthropic-messages",
      label: "anthropic",
    },
    {
      provider: "amazon-bedrock",
      modelApi: "bedrock-converse-stream",
      label: "bedrock",
    },
  ])("preserves replay-safe signed tool ids for $label history", async ({ provider, modelApi }) => {
    setNonGoogleModelApi();

    const messages = castAgentMessages([
      makeUserMessage("retry"),
      makeAssistantMessage([
        {
          type: "thinking",
          thinking: "internal",
          thinkingSignature: "sig_1",
        },
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      ] as unknown as AssistantMessage["content"]),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    ]);

    const result = await sanitizeAnthropicHistory({
      provider,
      modelApi,
      messages,
    });

    expect((result[1] as Extract<AgentMessage, { role: "assistant" }>).content).toEqual([
      {
        type: "thinking",
        thinking: "internal",
        thinkingSignature: "sig_1",
      },
      { type: "toolCall", id: "call_1", name: "read", arguments: {} },
    ]);
    expect((result[2] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe("call_1");
  });

  it("keeps earlier mutable ids from colliding with later preserved signed ids", async () => {
    setNonGoogleModelApi();

    const sessionManager = makeMockSessionManager();
    const messages = castAgentMessages([
      makeUserMessage("first"),
      makeAssistantMessage([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }]),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first result" }],
        isError: false,
      }),
      makeUserMessage("second"),
      makeAssistantMessage(
        [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolCall", id: "call1", name: "read", arguments: {} },
        ] as unknown as AssistantMessage["content"],
        { stopReason: "toolUse" },
      ),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call1",
        toolName: "read",
        content: [{ type: "text", text: "second result" }],
        isError: false,
      }),
      makeUserMessage("retry"),
    ]);

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      sessionManager,
      sessionId: TEST_SESSION_ID,
    });
    const validated = await validateReplayTurns({
      messages: sanitized,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      sessionId: TEST_SESSION_ID,
    });

    const firstAssistant = sanitized[1] as Extract<AgentMessage, { role: "assistant" }>;
    const secondAssistant = sanitized[4] as Extract<AgentMessage, { role: "assistant" }>;
    const firstToolCall = firstAssistant.content[0] as { id?: string };
    const secondToolCall = secondAssistant.content[1] as { id?: string };
    expect(firstToolCall.id).not.toBe("call1");
    expect(secondToolCall.id).toBe("call1");
    expect(firstToolCall.id).not.toBe(secondToolCall.id);
    expect((sanitized[2] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe(
      firstToolCall.id,
    );
    expect((sanitized[5] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe(
      "call1",
    );
    expect((validated[4] as Extract<AgentMessage, { role: "assistant" }>).content).toEqual([
      { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
      { type: "toolCall", id: "call1", name: "read", arguments: {} },
    ]);
  });

  it("keeps mutable thinking turns outside exact anthropic replay", async () => {
    setNonGoogleModelApi();

    const messages = castAgentMessages([
      makeUserMessage("read a file"),
      makeAssistantMessage([
        {
          type: "thinking",
          thinking: "I should use the read tool",
          thinkingSignature: "reasoning_text",
        },
        { type: "toolCall", id: "tool_123", name: " read ", arguments: { path: "/tmp/test" } },
      ]),
    ]);

    const result = await sanitizeGithubCopilotHistory({ messages });
    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([
      {
        type: "thinking",
        thinking: "I should use the read tool",
        thinkingSignature: "reasoning_text",
      },
      { type: "toolCall", id: "tool_123", name: "read", arguments: { path: "/tmp/test" } },
    ]);
  });

  it("drops later preserved signed turns that reuse an earlier raw tool id across the transcript", async () => {
    setNonGoogleModelApi();

    const sessionManager = makeMockSessionManager();
    const messages = castAgentMessages([
      makeUserMessage("first"),
      makeAssistantMessage(
        [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          { type: "toolCall", id: "call1", name: "read", arguments: {} },
        ] as unknown as AssistantMessage["content"],
        { stopReason: "toolUse" },
      ),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call1",
        toolName: "read",
        content: [{ type: "text", text: "first result" }],
        isError: false,
      }),
      makeUserMessage("second"),
      makeAssistantMessage(
        [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_2" },
          { type: "toolCall", id: "call1", name: "read", arguments: {} },
        ] as unknown as AssistantMessage["content"],
        { stopReason: "toolUse" },
      ),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call1",
        toolName: "read",
        content: [{ type: "text", text: "second result" }],
        isError: false,
      }),
      makeUserMessage("retry"),
    ]);

    const sanitized = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      sessionManager,
      sessionId: TEST_SESSION_ID,
    });
    const validated = await validateReplayTurns({
      messages: sanitized,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      sessionId: TEST_SESSION_ID,
    });

    expect(
      sanitized.filter(
        (message) =>
          message &&
          typeof message === "object" &&
          message.role === "assistant" &&
          extractToolCallsFromAssistant(message).length > 0,
      ),
    ).toHaveLength(1);
    expect(
      sanitized.filter(
        (message) => message && typeof message === "object" && message.role === "toolResult",
      ),
    ).toHaveLength(1);
    expect(
      validated.filter(
        (message) =>
          message &&
          typeof message === "object" &&
          message.role === "assistant" &&
          extractToolCallsFromAssistant(message).length > 0,
      ),
    ).toHaveLength(1);
    expect(
      validated.filter(
        (message) => message && typeof message === "object" && message.role === "toolResult",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(validated)).not.toContain("[tool calls omitted]");
  });

  it("keeps the earlier anthropic replay prefix stable after a later subagent turn", async () => {
    setNonGoogleModelApi();

    const priorToolId = "toolu_01ABCDEF1234567890";
    const laterToolId = "toolu_01ZZZZZZ9999999999";
    const nativeAnthropicPolicy: TranscriptPolicy = {
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: true,
      repairToolUseResultPairing: true,
      preserveSignatures: true,
      sanitizeThoughtSignatures: undefined,
      sanitizeThinkingSignatures: false,
      dropThinkingBlocks: true,
      applyGoogleTurnOrdering: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    };
    const baseMessages = castAgentMessages([
      makeUserMessage("Read IDENTITY.md"),
      makeAssistantMessage(
        [
          { type: "toolUse", id: priorToolId, name: "read", input: { path: "IDENTITY.md" } },
        ] as unknown as AssistantMessage["content"],
        { stopReason: "toolUse" },
      ),
      {
        role: "toolResult",
        toolCallId: priorToolId,
        toolUseId: priorToolId,
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      makeAssistantMessage([{ type: "text", text: "done" }]),
    ]);
    const withSubagentMessages = castAgentMessages([
      ...baseMessages,
      makeUserMessage("Ask a subagent for an emoji"),
      makeAssistantMessage(
        [
          { type: "toolUse", id: laterToolId, name: "subagent", input: { prompt: "emoji" } },
        ] as unknown as AssistantMessage["content"],
        { stopReason: "toolUse" },
      ),
      {
        role: "toolResult",
        toolCallId: laterToolId,
        toolUseId: laterToolId,
        toolName: "subagent",
        content: [{ type: "text", text: "😀" }],
        isError: false,
      },
      makeAssistantMessage([{ type: "text", text: "it was 😀" }]),
    ]);

    const sanitizedBase = await sanitizeAnthropicHistory({
      messages: baseMessages,
      policy: nativeAnthropicPolicy,
    });
    const sanitizedWithSubagent = await sanitizeAnthropicHistory({
      messages: withSubagentMessages,
      policy: nativeAnthropicPolicy,
    });

    expect(sanitizedWithSubagent.slice(0, sanitizedBase.length)).toEqual(sanitizedBase);
    expect((sanitizedBase[1] as Extract<AgentMessage, { role: "assistant" }>).content).toEqual([
      { type: "toolUse", id: priorToolId, name: "read", input: { path: "IDENTITY.md" } },
    ]);
    expect(
      (sanitizedBase[2] as Extract<AgentMessage, { role: "toolResult" }> & { toolUseId?: string })
        .toolCallId,
    ).toBe(priorToolId);
  });

  it("preserves latest assistant thinking blocks for amazon-bedrock replay", async () => {
    setNonGoogleModelApi();

    const messages = makeThinkingAndTextAssistantMessages();

    const result = await sanitizeAnthropicHistory({
      messages,
      provider: "amazon-bedrock",
      modelApi: "bedrock-converse-stream",
    });

    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([
      {
        type: "thinking",
        thinking: "internal",
        thinkingSignature: "some_sig",
      },
      { type: "text", text: "hi" },
    ]);
  });

  it("does not drop thinking blocks for non-claude copilot models", async () => {
    setNonGoogleModelApi();

    const messages = makeThinkingAndTextAssistantMessages();

    const result = await sanitizeGithubCopilotHistory({ messages, modelId: "gpt-5.4" });
    const types = getAssistantContentTypes(result);
    expect(types).toContain("thinking");
  });
});

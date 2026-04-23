import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";

const streamSimpleMock = vi.fn();
const buildSessionContextMock = vi.fn();
const getLeafEntryMock = vi.fn();
const branchMock = vi.fn();
const resetLeafMock = vi.fn();
const ensureOpenClawModelsJsonMock = vi.fn();
const discoverAuthStorageMock = vi.fn();
const discoverModelsMock = vi.fn();
const resolveModelWithRegistryMock = vi.fn();
const getApiKeyForModelMock = vi.fn();
const requireApiKeyMock = vi.fn();
const resolveSessionAuthProfileOverrideMock = vi.fn();
const getActiveEmbeddedRunSnapshotMock = vi.fn();
const resolveSessionAgentIdMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const prepareProviderRuntimeAuthMock = vi.fn();
const registerProviderStreamForModelMock = vi.fn();
const diagDebugMock = vi.fn();

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...original,
    streamSimple: (...args: unknown[]) => streamSimpleMock(...args),
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  generateSummary: vi.fn(async () => "summary"),
  SessionManager: {
    open: () => ({
      getLeafEntry: getLeafEntryMock,
      branch: branchMock,
      resetLeaf: resetLeafMock,
      buildSessionContext: buildSessionContextMock,
    }),
  },
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: (...args: unknown[]) => ensureOpenClawModelsJsonMock(...args),
}));

vi.mock("./pi-model-discovery.js", () => ({
  discoverAuthStorage: (...args: unknown[]) => discoverAuthStorageMock(...args),
  discoverModels: (...args: unknown[]) => discoverModelsMock(...args),
}));

vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModelWithRegistry: (...args: unknown[]) => resolveModelWithRegistryMock(...args),
}));

vi.mock("./model-auth.js", () => ({
  getApiKeyForModel: (...args: unknown[]) => getApiKeyForModelMock(...args),
  requireApiKey: (...args: unknown[]) => requireApiKeyMock(...args),
}));

vi.mock("./pi-embedded-runner/runs.js", () => ({
  getActiveEmbeddedRunSnapshot: (...args: unknown[]) => getActiveEmbeddedRunSnapshotMock(...args),
}));

vi.mock("./agent-scope.js", () => ({
  resolveSessionAgentId: (...args: unknown[]) => resolveSessionAgentIdMock(...args),
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  prepareProviderRuntimeAuth: (...args: unknown[]) => prepareProviderRuntimeAuthMock(...args),
}));

vi.mock("./provider-stream.js", () => ({
  registerProviderStreamForModel: (...args: unknown[]) =>
    registerProviderStreamForModelMock(...args),
}));

vi.mock("./auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: (...args: unknown[]) =>
    resolveSessionAuthProfileOverrideMock(...args),
}));

vi.mock("../logging/diagnostic.js", () => ({
  diagnosticLogger: {
    debug: (...args: unknown[]) => diagDebugMock(...args),
  },
}));

const { runBtwSideQuestion } = await import("./btw.js");
type RunBtwSideQuestionParams = Parameters<typeof runBtwSideQuestion>[0];

const DEFAULT_AGENT_DIR = "/tmp/agent";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_REASONING_LEVEL = "off";
const DEFAULT_SESSION_KEY = "agent:main:main";
const DEFAULT_STORE_PATH = "/tmp/sessions.json";
const DEFAULT_QUESTION = "What changed?";
const MATH_QUESTION = "What is 17 * 19?";
const MATH_ANSWER = "323";

const DEFAULT_USAGE = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAsyncEvents(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    sessionFile: "session-1.jsonl",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createAssistantDoneEvent(content: unknown[]) {
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content,
      provider: DEFAULT_PROVIDER,
      api: "anthropic-messages",
      model: DEFAULT_MODEL,
      stopReason: "stop",
      usage: DEFAULT_USAGE,
      timestamp: Date.now(),
    },
  };
}

function createDoneEvent(text: string) {
  return createAssistantDoneEvent([{ type: "text", text }]);
}

function createThinkingOnlyDoneEvent(thinking: string) {
  return createAssistantDoneEvent([{ type: "thinking", thinking }]);
}

function mockDoneAnswer(text: string) {
  streamSimpleMock.mockReturnValue(makeAsyncEvents([createDoneEvent(text)]));
}

function runSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runBtwSideQuestion({
    cfg: {} as never,
    agentDir: DEFAULT_AGENT_DIR,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    question: DEFAULT_QUESTION,
    sessionEntry: createSessionEntry(),
    resolvedReasoningLevel: DEFAULT_REASONING_LEVEL,
    opts: {},
    isNewSession: false,
    ...overrides,
  });
}

function runMathSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runSideQuestion({
    question: MATH_QUESTION,
    ...overrides,
  });
}

function clearBuiltSessionMessages() {
  buildSessionContextMock.mockReturnValue({ messages: [] });
}

function createUserTranscriptMessage(content: unknown[] = [{ type: "text", text: "seed" }]) {
  return {
    role: "user",
    content,
    timestamp: 1,
  };
}

function createAssistantTranscriptMessage(
  content: unknown,
  overrides: {
    stopReason?: string;
    output?: number;
    timestamp?: number;
  } = {},
) {
  return {
    role: "assistant",
    content,
    provider: DEFAULT_PROVIDER,
    api: "anthropic-messages",
    model: DEFAULT_MODEL,
    stopReason: overrides.stopReason ?? "stop",
    usage: {
      ...DEFAULT_USAGE,
      output: overrides.output ?? DEFAULT_USAGE.output,
      totalTokens: 1 + (overrides.output ?? DEFAULT_USAGE.output),
    },
    timestamp: overrides.timestamp ?? 2,
  };
}

function mockActiveTranscript(messages: unknown[]) {
  getActiveEmbeddedRunSnapshotMock.mockReturnValue({
    transcriptLeafId: "assistant-1",
    messages,
  });
}

async function runMathSideQuestionAndCaptureContext() {
  mockDoneAnswer(MATH_ANSWER);
  await runMathSideQuestion();
  const [, context] = streamSimpleMock.mock.calls[0] ?? [];
  return context;
}

function expectNoAssistantMessages(context: unknown) {
  expect(
    (context as { messages?: Array<{ role?: string }> }).messages?.filter(
      (message) => message.role === "assistant",
    ),
  ).toHaveLength(0);
}

function expectSanitizedAssistantContext(context: unknown, text: string) {
  expect(context).toMatchObject({
    messages: [
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text }],
      }),
      expect.objectContaining({ role: "user" }),
    ],
  });
}

function expectSeedOnlyUserContext(context: unknown) {
  expect(context).toMatchObject({
    messages: [
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "seed" }],
      }),
      expect.objectContaining({ role: "user" }),
    ],
  });
}

describe("runBtwSideQuestion", () => {
  beforeEach(() => {
    streamSimpleMock.mockReset();
    buildSessionContextMock.mockReset();
    getLeafEntryMock.mockReset();
    branchMock.mockReset();
    resetLeafMock.mockReset();
    ensureOpenClawModelsJsonMock.mockReset();
    discoverAuthStorageMock.mockReset();
    discoverModelsMock.mockReset();
    resolveModelWithRegistryMock.mockReset();
    getApiKeyForModelMock.mockReset();
    requireApiKeyMock.mockReset();
    resolveSessionAuthProfileOverrideMock.mockReset();
    getActiveEmbeddedRunSnapshotMock.mockReset();
    resolveSessionAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    prepareProviderRuntimeAuthMock.mockReset();
    registerProviderStreamForModelMock.mockReset();
    diagDebugMock.mockReset();

    buildSessionContextMock.mockReturnValue({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
    });
    getLeafEntryMock.mockReturnValue(null);
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      api: "anthropic-messages",
    });
    getApiKeyForModelMock.mockResolvedValue({ apiKey: "secret", mode: "api-key", source: "test" });
    requireApiKeyMock.mockReturnValue("secret");
    resolveSessionAuthProfileOverrideMock.mockResolvedValue("profile-1");
    getActiveEmbeddedRunSnapshotMock.mockReturnValue(undefined);
    resolveSessionAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    prepareProviderRuntimeAuthMock.mockResolvedValue(undefined);
    registerProviderStreamForModelMock.mockReturnValue(undefined);
  });

  it("streams blocks without persisting BTW data to disk", async () => {
    const onBlockReply = vi.fn().mockResolvedValue(undefined);
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "text_delta",
          delta: "Side answer.",
          partial: {
            role: "assistant",
            content: [],
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
        {
          type: "text_end",
          content: "Side answer.",
          contentIndex: 0,
          partial: {
            role: "assistant",
            content: [],
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Side answer." }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: DEFAULT_AGENT_DIR,
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      question: DEFAULT_QUESTION,
      sessionEntry: createSessionEntry(),
      sessionStore: {},
      sessionKey: DEFAULT_SESSION_KEY,
      storePath: DEFAULT_STORE_PATH,
      resolvedThinkLevel: "low",
      resolvedReasoningLevel: DEFAULT_REASONING_LEVEL,
      blockReplyChunking: {
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      },
      resolvedBlockStreamingBreak: "text_end",
      opts: { onBlockReply },
      isNewSession: false,
    });

    expect(result).toBeUndefined();
    expect(onBlockReply).toHaveBeenCalledWith({
      text: "Side answer.",
      btw: { question: DEFAULT_QUESTION },
    });
  });

  it("returns a final payload when block streaming is unavailable", async () => {
    mockDoneAnswer("Final answer.");

    const result = await runSideQuestion();

    expect(result).toEqual({ text: "Final answer." });
  });

  it("applies provider runtime auth before streaming github-copilot BTW questions", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "github-copilot",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "github-token",
      mode: "token",
      source: "profile",
      profileId: "github-copilot:github",
    });
    requireApiKeyMock.mockReturnValue("github-token");
    prepareProviderRuntimeAuthMock.mockResolvedValue({
      apiKey: "copilot-runtime-token",
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    mockDoneAnswer("Copilot answer.");

    const result = await runSideQuestion({
      provider: "github-copilot",
      model: "gpt-5.4",
    });

    expect(result).toEqual({ text: "Copilot answer." });
    expect(prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        workspaceDir: "/tmp/workspace",
        context: expect.objectContaining({
          provider: "github-copilot",
          modelId: "gpt-5.4",
          workspaceDir: "/tmp/workspace",
          apiKey: "github-token",
          authMode: "token",
          profileId: "profile-1",
        }),
      }),
    );
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        id: "gpt-5.4",
        baseUrl: "https://api.enterprise.githubcopilot.com",
      }),
      expect.anything(),
      expect.objectContaining({ apiKey: "copilot-runtime-token" }),
    );
  });

  it("uses the provider's stream fn when registered so provider URL construction runs (#68336)", async () => {
    // Regression: before this fix, /btw called streamSimple directly and
    // bypassed the provider's createStreamFn/wrapStreamFn hooks. That caused
    // Ollama Cloud (api: "openai-completions", baseUrl: "https://ollama.com/")
    // to hit the marketing site instead of /v1/chat/completions.
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "ollama",
      id: "glm-5.1",
      api: "openai-completions",
      baseUrl: "https://ollama.com/",
    });
    const providerStreamFn = vi
      .fn()
      .mockReturnValue(makeAsyncEvents([createDoneEvent("Ollama Cloud answer.")]));
    registerProviderStreamForModelMock.mockReturnValue(providerStreamFn);

    const result = await runSideQuestion({ provider: "ollama", model: "glm-5.1" });

    expect(result).toEqual({ text: "Ollama Cloud answer." });
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          provider: "ollama",
          api: "openai-completions",
          baseUrl: "https://ollama.com/",
        }),
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("falls back to streamSimple when no provider stream fn is registered", async () => {
    registerProviderStreamForModelMock.mockReturnValue(undefined);
    mockDoneAnswer("Fallback answer.");

    const result = await runSideQuestion();

    expect(result).toEqual({ text: "Fallback answer." });
    expect(streamSimpleMock).toHaveBeenCalledTimes(1);
  });

  it("strips injected empty tools arrays from BTW payloads before sending", async () => {
    mockDoneAnswer("Final answer.");

    await runSideQuestion();

    const [, , options] = streamSimpleMock.mock.calls[0] ?? [];
    const onPayload = (options as { onPayload?: (payload: unknown) => void })?.onPayload;
    const payloadWithEmptyTools = { messages: [], tools: [] as unknown[] };

    const result = onPayload?.(payloadWithEmptyTools);

    expect(payloadWithEmptyTools).not.toHaveProperty("tools");
    expect(result).toBeUndefined();
  });

  it("allows Bedrock /btw runs to proceed without a static api key in aws-sdk mode", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-5-v1:0",
      api: "anthropic-messages",
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: undefined,
      mode: "aws-sdk",
      source: "aws-sdk default chain",
    });
    streamSimpleMock.mockReturnValue(makeAsyncEvents([createDoneEvent("Bedrock answer.")]));

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: DEFAULT_AGENT_DIR,
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-5-v1:0",
      question: DEFAULT_QUESTION,
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: DEFAULT_REASONING_LEVEL,
      opts: {},
      isNewSession: false,
    });

    expect(result).toEqual({ text: "Bedrock answer." });
    expect(requireApiKeyMock).not.toHaveBeenCalled();
    const [, , options] = streamSimpleMock.mock.calls.at(-1) ?? [];
    expect((options as { apiKey?: string } | undefined)?.apiKey).toBeUndefined();
  });

  it("forces provider reasoning off even when the session think level is adaptive", async () => {
    streamSimpleMock.mockImplementation((_model, _input, options?: { reasoning?: unknown }) => {
      return options?.reasoning === undefined
        ? makeAsyncEvents([createDoneEvent("Final answer.")])
        : makeAsyncEvents([createThinkingOnlyDoneEvent("thinking only")]);
    });

    const result = await runSideQuestion({ resolvedThinkLevel: "adaptive" });

    expect(result).toEqual({ text: "Final answer." });
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reasoning: undefined }),
    );
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ reasoning: expect.anything() }),
    );
  });

  it("fails when the current branch has no messages", async () => {
    clearBuiltSessionMessages();
    streamSimpleMock.mockReturnValue(makeAsyncEvents([]));

    await expect(runSideQuestion()).rejects.toThrow("No active session context.");
  });

  it("uses active-run snapshot messages for BTW context while the main run is in flight", async () => {
    clearBuiltSessionMessages();
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "write some things then wait 30 seconds and write more" },
          ],
          timestamp: 1,
        },
      ],
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(result).toEqual({ text: MATH_ANSWER });
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        systemPrompt: expect.stringContaining("ephemeral /btw side question"),
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({
            role: "user",
            content: [
              {
                type: "text",
                text: expect.stringContaining(
                  `<btw_side_question>\n${MATH_QUESTION}\n</btw_side_question>`,
                ),
              },
            ],
          }),
        ]),
      }),
      expect.anything(),
    );
  });

  it("uses the in-flight prompt as background only when there is no prior transcript context", async () => {
    clearBuiltSessionMessages();
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: null,
      messages: [],
      inFlightPrompt: "build me a tic-tac-toe game in brainfuck",
    });
    mockDoneAnswer("You're building a tic-tac-toe game in Brainfuck.");

    const result = await runSideQuestion({ question: "what are we doing?" });

    expect(result).toEqual({ text: "You're building a tic-tac-toe game in Brainfuck." });
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: "user",
            content: [
              {
                type: "text",
                text: expect.stringContaining(
                  "<in_flight_main_task>\nbuild me a tic-tac-toe game in brainfuck\n</in_flight_main_task>",
                ),
              },
            ],
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it("wraps the side question so the model does not treat it as a main-task continuation", async () => {
    mockDoneAnswer("About 93 million miles.");

    await runSideQuestion({ question: "what is the distance to the sun?" });

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      systemPrompt: expect.stringContaining(
        "Do not continue, resume, or complete any unfinished task",
      ),
    });
    expect(context).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                "Ignore any unfinished task in the conversation while answering it.",
              ),
            },
          ],
        }),
      ]),
    });
  });

  it("branches away from an unresolved trailing user turn before building BTW context", async () => {
    getLeafEntryMock.mockReturnValue({
      type: "message",
      parentId: "assistant-1",
      message: { role: "user" },
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(branchMock).toHaveBeenCalledWith("assistant-1");
    expect(resetLeafMock).not.toHaveBeenCalled();
    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("branches to the active run snapshot leaf when the session is busy", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-seed",
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(branchMock).toHaveBeenCalledWith("assistant-seed");
    expect(getLeafEntryMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("falls back when the active run snapshot leaf no longer exists", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-gone",
    });
    branchMock.mockImplementationOnce(() => {
      throw new Error("Entry 3235c7c4 not found");
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(branchMock).toHaveBeenCalledWith("assistant-gone");
    expect(resetLeafMock).toHaveBeenCalled();
    expect(result).toEqual({ text: MATH_ANSWER });
    expect(diagDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("btw snapshot leaf unavailable: sessionId=session-1"),
    );
  });

  it("returns the BTW answer without appending transcript custom entries", async () => {
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(result).toEqual({ text: MATH_ANSWER });
    expect(buildSessionContextMock).toHaveBeenCalled();
  });

  it("does not log transcript persistence warnings because BTW no longer writes to disk", async () => {
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(result).toEqual({ text: MATH_ANSWER });
    expect(diagDebugMock).not.toHaveBeenCalledWith(
      expect.stringContaining("btw transcript persistence skipped"),
    );
  });

  it("excludes tool results from BTW context to avoid replaying raw tool output", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      {
        role: "toolResult",
        content: [{ type: "text", text: "sensitive tool output" }],
        details: { raw: "secret" },
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: 3,
      },
    ]);
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      messages: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "user" }),
      ],
    });
    expect((context as { messages?: Array<{ role?: string }> }).messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "toolResult" })]),
    );
  });

  it("strips assistant tool calls from BTW context so no-tool side questions stay tool-free", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [
          { type: "text", text: "Let me check." },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
          { type: "toolUse", id: "call_legacy", name: "read", input: { path: "README.md" } },
          { type: "tool_call", id: "call_snake", name: "read", arguments: { path: "README.md" } },
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expectSanitizedAssistantContext(context, "Let me check.");
    expect(
      (context as { messages?: Array<{ role?: string; content?: Array<{ type?: string }> }> })
        .messages,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "toolCall" }),
            expect.objectContaining({ type: "toolUse" }),
            expect.objectContaining({ type: "tool_call" }),
          ]),
        }),
      ]),
    );
  });

  it("drops assistant messages that contain only tool calls", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        { stopReason: "toolUse", output: 0 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectNoAssistantMessages(context);
  });

  it("strips embedded user tool results from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage([
        { type: "text", text: "seed" },
        {
          type: "toolResult",
          toolUseId: "call_1",
          content: [{ type: "text", text: "secret" }],
        },
        {
          type: "tool_result",
          toolUseId: "call_2",
          content: [{ type: "text", text: "secret-2" }],
        },
      ]),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();
    expectSeedOnlyUserContext(context);
  });

  it("drops assistant thinking blocks from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [
          { type: "text", text: "Visible answer" },
          { type: "thinking", thinking: "Hidden chain of thought" },
        ],
        { output: 1 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectSanitizedAssistantContext(context, "Visible answer");
    expect(
      (context as { messages?: Array<{ role?: string; content?: Array<{ type?: string }> }> })
        .messages,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([expect.objectContaining({ type: "thinking" })]),
        }),
      ]),
    );
  });

  it("drops thinking-only assistant messages from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [{ type: "thinking", thinking: "Hidden chain of thought" }],
        { output: 1 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectNoAssistantMessages(context);
  });

  it("drops malformed user image blocks from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage([
        { type: "text", text: "seed" },
        { type: "image", mimeType: "image/png" },
      ]),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();
    expectSeedOnlyUserContext(context);
  });

  it("normalizes malformed assistant content before stripping tool blocks", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        { stopReason: "toolUse", output: 0 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectNoAssistantMessages(context);
  });
});

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { expect, vi } from "vitest";
import type { TranscriptPolicy } from "./transcript-policy.js";

export type SessionEntry = { type: string; customType: string; data: unknown };
export type SanitizeSessionHistoryFn = (params: {
  messages: AgentMessage[];
  modelApi: string;
  provider: string;
  allowedToolNames?: Iterable<string>;
  sessionManager: SessionManager;
  sessionId: string;
  modelId?: string;
  policy?: TranscriptPolicy;
}) => Promise<AgentMessage[]>;
export type SanitizeSessionHistoryMockedHelpers = typeof import("./pi-embedded-helpers.js");
export type SanitizeSessionHistoryHarness = {
  sanitizeSessionHistory: SanitizeSessionHistoryFn;
  mockedHelpers: SanitizeSessionHistoryMockedHelpers;
};
export const TEST_SESSION_ID = "test-session";

export function makeModelSnapshotEntry(data: {
  timestamp?: number;
  provider: string;
  modelApi: string;
  modelId: string;
}): SessionEntry {
  return {
    type: "custom",
    customType: "model-snapshot",
    data: {
      timestamp: data.timestamp ?? Date.now(),
      provider: data.provider,
      modelApi: data.modelApi,
      modelId: data.modelId,
    },
  };
}

export function makeInMemorySessionManager(entries: SessionEntry[]): SessionManager {
  return {
    getEntries: vi.fn(() => entries),
    appendCustomEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
  } as unknown as SessionManager;
}

export function makeMockSessionManager(): SessionManager {
  return {
    getEntries: vi.fn().mockReturnValue([]),
    appendCustomEntry: vi.fn(),
  } as unknown as SessionManager;
}

export function makeSimpleUserMessages(): AgentMessage[] {
  const messages = [{ role: "user", content: "hello" }];
  return messages as unknown as AgentMessage[];
}

export async function createSanitizeSessionHistoryHelpersMock(extra: Record<string, unknown> = {}) {
  return {
    ...(await vi.importActual("./pi-embedded-helpers.js")),
    sanitizeSessionMessagesImages: vi.fn(async (msgs) => msgs),
    ...extra,
  };
}

export async function createSanitizeSessionHistoryProviderRuntimeMock(
  extra: Record<string, unknown> = {},
) {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderRuntimePlugin: vi.fn(() => undefined),
    sanitizeProviderReplayHistoryWithPlugin: vi.fn(() => undefined),
    validateProviderReplayTurnsWithPlugin: vi.fn(() => undefined),
    ...extra,
  };
}

export function createSanitizeSessionHistoryProviderHookRuntimeMock(
  extra: Record<string, unknown> = {},
) {
  return {
    resolveProviderRuntimePlugin: vi.fn(() => undefined),
    resolveProviderHookPlugin: vi.fn(() => undefined),
    resolveProviderPluginsForHooks: vi.fn(() => []),
    prepareProviderExtraParams: vi.fn(() => undefined),
    wrapProviderStreamFn: vi.fn(() => undefined),
    clearProviderRuntimeHookCache: vi.fn(),
    resetProviderRuntimeHookCacheForTest: vi.fn(),
    __testing: {},
    ...extra,
  };
}

export async function loadSanitizeSessionHistoryWithCleanMocks(): Promise<SanitizeSessionHistoryHarness> {
  vi.resetModules();
  vi.resetAllMocks();
  const mockedHelpers = await import("./pi-embedded-helpers.js");
  vi.mocked(mockedHelpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
  const mod = await import("./pi-embedded-runner/replay-history.js");
  return {
    sanitizeSessionHistory: mod.sanitizeSessionHistory,
    mockedHelpers,
  };
}

export function makeReasoningAssistantMessages(opts?: {
  thinkingSignature?: "object" | "json";
}): AgentMessage[] {
  const thinkingSignature: unknown =
    opts?.thinkingSignature === "json"
      ? JSON.stringify({ id: "rs_test", type: "reasoning" })
      : { id: "rs_test", type: "reasoning" };

  // Intentional: we want to build message payloads that can carry non-string
  // signatures, but core typing currently expects a string.
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "reasoning",
          thinkingSignature,
        },
      ],
    },
  ];

  return messages as unknown as AgentMessage[];
}

export async function sanitizeWithOpenAIResponses(params: {
  sanitizeSessionHistory: SanitizeSessionHistoryFn;
  messages: AgentMessage[];
  sessionManager: SessionManager;
  modelId?: string;
}) {
  return await params.sanitizeSessionHistory({
    messages: params.messages,
    modelApi: "openai-responses",
    provider: "openai",
    sessionManager: params.sessionManager,
    modelId: params.modelId,
    sessionId: TEST_SESSION_ID,
  });
}

export function expectOpenAIResponsesStrictSanitizeCall(
  sanitizeSessionMessagesImagesMock: unknown,
  messages: AgentMessage[],
) {
  expect(sanitizeSessionMessagesImagesMock).toHaveBeenCalledWith(
    messages,
    "session:history",
    expect.objectContaining({
      sanitizeMode: "images-only",
      sanitizeToolCallIds: false,
      toolCallIdMode: "strict",
    }),
  );
}

export function makeSnapshotChangedOpenAIReasoningScenario() {
  const sessionEntries = [
    makeModelSnapshotEntry({
      provider: "anthropic",
      modelApi: "anthropic-messages",
      modelId: "claude-3-7",
    }),
  ];
  return {
    sessionManager: makeInMemorySessionManager(sessionEntries),
    messages: makeReasoningAssistantMessages({ thinkingSignature: "object" }),
    modelId: "gpt-5.4",
  };
}

export async function sanitizeSnapshotChangedOpenAIReasoning(params: {
  sanitizeSessionHistory: SanitizeSessionHistoryFn;
}) {
  const { sessionManager, messages, modelId } = makeSnapshotChangedOpenAIReasoningScenario();
  return await sanitizeWithOpenAIResponses({
    sanitizeSessionHistory: params.sanitizeSessionHistory,
    messages,
    modelId,
    sessionManager,
  });
}

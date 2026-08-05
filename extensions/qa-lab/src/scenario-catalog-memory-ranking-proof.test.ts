import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const searchCallId = "call-session-memory-ranking";
const searchQuery = "current Project Nebula codename";
const currentQuestionResult = {
  path: "sessions/qa/current-session-memory-ranking.jsonl",
  source: "sessions",
  snippet: "User: Session memory ranking check: what is the current Project Nebula codename?",
  score: 0.98,
};
const currentSessionResult = {
  path: "sessions/qa-session-memory-ranking.jsonl",
  source: "sessions",
  snippet: "The current Project Nebula codename is ORBIT-10.",
  score: 0.8,
};
const evergreenUserResult = {
  path: "USER.md",
  source: "memory",
  snippet: "About Your Human: preferred project communication style.",
  score: 0.68,
};
const staleDurableResult = {
  path: `memory/${new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)}.md`,
  source: "memory",
  snippet: "Project Nebula current codename: ORBIT-9.",
  score: 0.9,
};

type RankingResult =
  | typeof currentQuestionResult
  | typeof currentSessionResult
  | typeof evergreenUserResult
  | typeof staleDurableResult;
type ProviderMode = "mock-openai" | "live-frontier";

async function runSessionMemoryRankingFlow(params: {
  results: RankingResult[];
  providerMode?: ProviderMode;
  query?: string;
  maxResults?: number;
  omitMaxResults?: boolean;
  corpus?: "memory" | "sessions" | "all";
  includeToolCall?: boolean;
  includeToolResult?: boolean;
  resultCallId?: string;
  resultIsError?: boolean;
}) {
  const state = createQaBusState();
  const providerMode = params.providerMode ?? "mock-openai";
  const includeToolCall = params.includeToolCall !== false;
  const includeToolResult = params.includeToolResult !== false;
  const plannedToolArgs = {
    query: params.query ?? searchQuery,
    ...(params.omitMaxResults ? {} : { maxResults: params.maxResults ?? 6 }),
    ...(params.corpus ? { corpus: params.corpus } : {}),
  };
  const toolResultCallId = params.resultCallId ?? searchCallId;
  const requests = [
    ...(includeToolCall
      ? [
          {
            cursor: 41,
            allInputText: "Session memory ranking check",
            plannedToolName: "memory_search",
            plannedToolCallId: searchCallId,
            plannedToolArgs,
          },
        ]
      : []),
    ...(includeToolResult
      ? [
          {
            cursor: 42,
            allInputText: "Session memory ranking check",
            toolOutputCallId: toolResultCallId,
            toolOutput: JSON.stringify({ results: params.results }),
            ...(params.resultIsError ? { toolOutputStructuredError: true } : {}),
          },
        ]
      : []),
  ];
  const historyMessages = [
    ...(includeToolCall
      ? [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: searchCallId,
                name: "memory_search",
                arguments: plannedToolArgs,
              },
            ],
          },
        ]
      : []),
    ...(includeToolResult
      ? [
          {
            role: "toolResult",
            toolCallId: toolResultCallId,
            toolName: "memory_search",
            isError: params.resultIsError === true,
            content: [{ type: "text", text: JSON.stringify({ results: params.results }) }],
          },
        ]
      : []),
    {
      role: "assistant",
      content: [{ type: "text", text: "The current Project Nebula codename is ORBIT-10." }],
    },
  ];
  const gatewayCall = vi.fn(
    async (method: string, request: { sessionKey?: string; limit?: number }) => {
      expect(method).toBe("chat.history");
      expect(request.sessionKey).toBe("agent:qa:session-memory-ranking");
      return { messages: historyMessages };
    },
  );
  const fetchJson = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === "/debug/request-cursor") {
      return { cursor: 40 };
    }
    if (url.pathname === "/debug/requests") {
      const after = Number(url.searchParams.get("after") ?? 0);
      return requests.filter((request) => request.cursor > after);
    }
    throw new Error(`unexpected QA mock request: ${input}`);
  });
  const forceMemoryIndex = vi.fn(async () => undefined);
  const writeFile = vi.fn(
    async (_filePath: string, _content: string, _encoding: string) => undefined,
  );
  const utimes = vi.fn(
    async (_filePath: string, _accessedAt: Date, _modifiedAt: Date) => undefined,
  );
  const runAgentPrompt = vi.fn(async (_env: unknown, options: { message: string }) => {
    expect(options.message).not.toContain("ORBIT-10");
    state.addOutboundMessage({
      accountId: "qa-channel",
      to: "dm:qa-operator",
      text: "The current Project Nebula codename is ORBIT-10.",
    });
  });

  const result = await runLoadedScenarioFlow("session-memory-ranking", {
    state,
    api: {
      env: {
        providerMode,
        gateway: { workspaceDir: "/qa/workspace", call: gatewayCall },
        ...(providerMode === "mock-openai" ? { mock: { baseUrl: "http://qa.mock" } } : {}),
      },
      path,
      fs: {
        mkdir: async () => undefined,
        writeFile,
        utimes,
      },
      readConfigSnapshot: async () => ({ config: {} }),
      patchConfig: async () => undefined,
      seedQaSessionTranscript: async () => undefined,
      forceMemoryIndex,
      runAgentPrompt,
      normalizeLowercaseStringOrEmpty: (value: unknown) =>
        typeof value === "string" ? value.trim().toLowerCase() : "",
      fetchJson,
    },
  });

  return { result, fetchJson, forceMemoryIndex, gatewayCall, runAgentPrompt, utimes, writeFile };
}

describe("session memory ranking scenario evidence", () => {
  it.each(["mock-openai", "live-frontier"] as const)(
    "accepts current session memory ranked before competing stale durable memory (%s)",
    async (providerMode) => {
      const { result } = await runSessionMemoryRankingFlow({
        providerMode,
        results: [currentSessionResult, staleDurableResult],
      });

      expect(result.status).toBe("pass");
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "compares conflicting facts while ignoring the current question and evergreen USER note (%s)",
    async (providerMode) => {
      const { result } = await runSessionMemoryRankingFlow({
        providerMode,
        results: [
          currentQuestionResult,
          currentSessionResult,
          evergreenUserResult,
          staleDurableResult,
        ],
      });

      expect(result.status).toBe("pass");
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "seeds the conflicting durable fact in an authentic three-day-old daily note (%s)",
    async (providerMode) => {
      const startedAt = Date.now();
      const { utimes, writeFile } = await runSessionMemoryRankingFlow({
        providerMode,
        results: [
          currentQuestionResult,
          currentSessionResult,
          evergreenUserResult,
          staleDurableResult,
        ],
      });
      const completedAt = Date.now();
      const [stalePath, staleContent] = writeFile.mock.calls[0] ?? [];
      const [datedPath, accessedAt, modifiedAt] = utimes.mock.calls[0] ?? [];

      expect(stalePath).toMatch(/^\/qa\/workspace\/memory\/\d{4}-\d{2}-\d{2}\.md$/);
      expect(staleContent).toContain("Project Nebula current codename: ORBIT-9.");
      expect(datedPath).toBe(stalePath);
      expect(accessedAt).toBeInstanceOf(Date);
      expect(modifiedAt).toBe(accessedAt);
      expect(accessedAt?.getTime()).toBeGreaterThanOrEqual(startedAt - 3 * 86_400_000);
      expect(accessedAt?.getTime()).toBeLessThanOrEqual(completedAt - 3 * 86_400_000);
      expect(stalePath).toBe(`/qa/workspace/memory/${accessedAt?.toISOString().slice(0, 10)}.md`);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "requires successful provider-independent persisted search evidence (%s)",
    async (providerMode) => {
      const { fetchJson, gatewayCall, runAgentPrompt } = await runSessionMemoryRankingFlow({
        providerMode,
        results: [currentSessionResult, staleDurableResult],
      });

      expect(runAgentPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          transcriptToolName: "memory_search",
          requireSuccessfulTranscriptToolResult: true,
        }),
      );
      expect(gatewayCall).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({ sessionKey: "agent:qa:session-memory-ranking" }),
        expect.anything(),
      );
      expect(fetchJson).not.toHaveBeenCalled();
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "uses an answer-free setup query and requests unfiltered memory ranking (%s)",
    async (providerMode) => {
      const { forceMemoryIndex, runAgentPrompt } = await runSessionMemoryRankingFlow({
        providerMode,
        results: [currentSessionResult, staleDurableResult],
      });

      expect(forceMemoryIndex).toHaveBeenCalledWith(
        expect.objectContaining({ query: searchQuery, expectedNeedle: "ORBIT-10" }),
      );
      const options = runAgentPrompt.mock.calls[0]?.[1];
      expect(options?.message).not.toMatch(/corpus\s*=\s*(sessions|memory)/i);
      expect(options?.message).toMatch(/without\s+(?:a\s+)?corpus\s+filter|unfiltered/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects a fabricated correct answer without a planned memory search (%s)",
    async (providerMode) => {
      await expect(
        runSessionMemoryRankingFlow({
          providerMode,
          results: [currentSessionResult, staleDurableResult],
          includeToolCall: false,
        }),
      ).rejects.toThrow(/memory_search|search|correlat/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects a fabricated correct answer without a successful memory result (%s)",
    async (providerMode) => {
      await expect(
        runSessionMemoryRankingFlow({
          providerMode,
          results: [currentSessionResult, staleDurableResult],
          includeToolResult: false,
        }),
      ).rejects.toThrow(/memory_search|search|result|correlat/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects a failed result even when it contains the correct answer (%s)",
    async (providerMode) => {
      await expect(
        runSessionMemoryRankingFlow({
          providerMode,
          results: [currentSessionResult, staleDurableResult],
          resultIsError: true,
        }),
      ).rejects.toThrow(/memory_search|search|result|success|correlat/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects memory results belonging to a different search call (%s)",
    async (providerMode) => {
      await expect(
        runSessionMemoryRankingFlow({
          providerMode,
          results: [currentSessionResult, staleDurableResult],
          resultCallId: "call-unrelated-memory-search",
        }),
      ).rejects.toThrow(/memory_search|search|result|correlat/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects session results that never compete with the stale durable fact (%s)",
    async (providerMode) => {
      await expect(
        runSessionMemoryRankingFlow({ providerMode, results: [currentSessionResult] }),
      ).rejects.toThrow(/competi|durable|stale|both/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects stale durable memory ranked ahead of the current session fact (%s)",
    async (providerMode) => {
      await expect(
        runSessionMemoryRankingFlow({
          providerMode,
          results: [staleDurableResult, currentSessionResult],
        }),
      ).rejects.toThrow(/rank|stale|durable/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects stale facts ahead of current facts even when the current question ranks first (%s)",
    async (providerMode) => {
      await expect(
        runSessionMemoryRankingFlow({
          providerMode,
          results: [currentQuestionResult, staleDurableResult, currentSessionResult],
        }),
      ).rejects.toThrow(/rank|stale|durable/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "accepts an omitted result limit using the canonical six-result product default (%s)",
    async (providerMode) => {
      const { result } = await runSessionMemoryRankingFlow({
        providerMode,
        results: [
          currentQuestionResult,
          currentSessionResult,
          evergreenUserResult,
          staleDurableResult,
        ],
        omitMaxResults: true,
      });

      expect(result.status).toBe("pass");
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects a correlated memory search using less than the canonical six-result window (%s)",
    async (providerMode) => {
      await expect(
        runSessionMemoryRankingFlow({
          providerMode,
          results: [currentSessionResult, staleDurableResult],
          maxResults: 3,
        }),
      ).rejects.toThrow(/maxResults|result|six|6/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects search calls that exclude either configured memory source (%s)",
    async (providerMode) => {
      await expect(
        runSessionMemoryRankingFlow({
          providerMode,
          results: [currentSessionResult, staleDurableResult],
          corpus: "sessions",
        }),
      ).rejects.toThrow(/corpus|filter|unfiltered|competi/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects search queries that already reveal the expected answer (%s)",
    async (providerMode) => {
      await expect(
        runSessionMemoryRankingFlow({
          providerMode,
          results: [currentSessionResult, staleDurableResult],
          query: `${searchQuery} ORBIT-10`,
        }),
      ).rejects.toThrow(/answer|reveal|leak|query/i);
    },
  );
});

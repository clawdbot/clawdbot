// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadChatHistory, type ChatHistoryResult, type ChatState } from "./chat-history.ts";
import { handleAgentEvent, type PlanStatus, type ToolStreamEntry } from "./tool-stream.ts";

type TestState = ChatState &
  Parameters<typeof handleAgentEvent>[0] & {
    requestUpdate: () => void;
  };

function createState(result: ChatHistoryResult): TestState {
  const client = {
    request: vi.fn().mockResolvedValue(result),
  } as unknown as GatewayBrowserClient;
  return {
    client,
    connected: true,
    connectionEpoch: 1,
    sessionKey: "main",
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamSegments: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    planStatus: {
      runId: "stale-run",
      steps: [{ step: "Reset me", status: "in_progress" }],
    },
    lastError: null,
    hello: null,
    sessions: {
      setModelOverride: vi.fn(),
    },
    requestUpdate: vi.fn(),
  };
}

function activeHistory(
  runId: string,
  plan?: NonNullable<ChatHistoryResult["inFlightRun"]>["plan"],
): ChatHistoryResult {
  return {
    messages: [],
    sessionInfo: {
      key: "main",
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: [runId],
      status: "running",
    },
    inFlightRun: {
      runId,
      text: "intentionally ignored on web",
      ...(plan !== undefined ? { plan } : {}),
    },
  } satisfies ChatHistoryResult;
}

describe("chat history plan replay", () => {
  const retainedPlan = {
    runId: "run-retained",
    steps: [{ step: "Retained", status: "in_progress" }],
  } satisfies PlanStatus;
  const livePlan = {
    runId: "run-live",
    steps: [{ step: "New live plan", status: "in_progress" }],
  } satisfies PlanStatus;
  const cases: Array<{
    name: string;
    history: ChatHistoryResult;
    expected: PlanStatus | null;
    staleAfterLivePlan?: boolean;
  }> = [
    {
      name: "replace",
      history: activeHistory("run-retained", {
        explanation: "  Reconnected work  ",
        steps: [
          { step: "First active", status: "in_progress" },
          { step: "Second active", status: "in_progress" },
          "Legacy step",
        ],
      }),
      expected: {
        runId: "run-retained",
        explanation: "Reconnected work",
        steps: [
          { step: "First active", status: "in_progress" },
          { step: "Second active", status: "pending" },
          { step: "Legacy step", status: "pending" },
        ],
      },
    },
    {
      name: "legacy-preserve",
      history: activeHistory("run-retained"),
      expected: retainedPlan,
    },
    {
      name: "superseded",
      history: activeHistory("run-next", {
        steps: [{ step: "Next run", status: "in_progress" }],
      }),
      expected: {
        runId: "run-next",
        steps: [{ step: "Next run", status: "in_progress" }],
      },
    },
    {
      name: "active-preserve",
      history: {
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: true,
          activeRunIds: ["run-retained"],
        },
      },
      expected: retainedPlan,
    },
    {
      name: "terminal-clear",
      history: {
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: false,
          activeRunIds: [],
        },
      },
      expected: null,
    },
    {
      name: "no-evidence-preserve",
      history: { messages: [] },
      expected: retainedPlan,
    },
    {
      name: "stale-response-does-not-clobber-newer-live-plan",
      history: {
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: false,
          activeRunIds: [],
        },
      },
      expected: livePlan,
      staleAfterLivePlan: true,
    },
    {
      name: "explicit-empty-clears",
      history: activeHistory("run-retained", { steps: [] }),
      expected: null,
    },
  ];

  it.each(cases)("$name", async (testCase) => {
    let resolveHistory!: (result: ChatHistoryResult) => void;
    const historyPromise = new Promise<ChatHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    const state = createState(testCase.history);
    state.planStatus = retainedPlan;
    if (testCase.staleAfterLivePlan) {
      const request = vi.fn().mockReturnValue(historyPromise);
      state.client = { request } as unknown as GatewayBrowserClient;
      const loadPromise = loadChatHistory(state);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      state.chatRunId = "run-live";
      handleAgentEvent(state, {
        runId: "run-live",
        seq: 2,
        stream: "plan",
        ts: 2,
        sessionKey: "main",
        data: {
          phase: "update",
          steps: [{ step: "New live plan", status: "in_progress" }],
        },
      });
      resolveHistory(testCase.history);
      await loadPromise;
    } else {
      await loadChatHistory(state);
    }

    expect(state.planStatus).toEqual(testCase.expected);
  });
});

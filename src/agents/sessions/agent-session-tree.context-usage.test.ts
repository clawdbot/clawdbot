import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "../../../packages/agent-core/src/llm.js";
import type { AgentMessage, SessionTreeEntry, StreamFn } from "../runtime/index.js";
import { AgentSessionTree } from "./agent-session-tree.js";
import type { AgentSessionEvent } from "./agent-session-types.js";

function createModel(): Model {
  return {
    id: "branch-summary-model",
    name: "Branch Summary Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000,
  };
}

function createMessageEntry(params: {
  id: string;
  parentId: string | null;
  content: string;
  timestamp: number;
}): SessionTreeEntry {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: new Date(params.timestamp).toISOString(),
    message: { role: "user", content: params.content, timestamp: params.timestamp },
  };
}

describe("AgentSessionTree branch summary usage", () => {
  it("emits provider usage from the successful branch summary value", async () => {
    const model = createModel();
    const usage = {
      input: 12_345,
      output: 678,
      cacheRead: 100,
      cacheWrite: 20,
      totalTokens: 13_143,
      cost: {
        input: 0.0185,
        output: 0.0049,
        cacheRead: 0.0001,
        cacheWrite: 0.0002,
        total: 0.0237,
      },
    };
    const streamFn = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Branch summary" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop",
        timestamp: 4,
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    });
    const common = createMessageEntry({
      id: "common",
      parentId: null,
      content: "shared prompt",
      timestamp: 1,
    });
    const abandoned = createMessageEntry({
      id: "abandoned",
      parentId: common.id,
      content: "work to summarize",
      timestamp: 2,
    });
    const target = createMessageEntry({
      id: "target",
      parentId: common.id,
      content: "return here",
      timestamp: 3,
    });
    let leafId = abandoned.id;
    const emittedEvents: AgentSessionEvent[] = [];
    const summaryEntry = {
      type: "branch_summary",
      id: "summary",
      parentId: common.id,
      timestamp: new Date(5).toISOString(),
      fromId: abandoned.id,
      summary: "Branch summary",
    };
    const session = {
      model,
      agent: { streamFn, state: { messages: [] as AgentMessage[] } },
      sessionManager: {
        getLeafId: () => leafId,
        getEntry: (id: string) => (id === target.id ? target : summaryEntry),
        getBranch: (id: string) => (id === abandoned.id ? [common, abandoned] : [common, target]),
        branchWithSummary: () => {
          leafId = summaryEntry.id;
          return summaryEntry.id;
        },
        buildSessionContext: () => ({ messages: [] }),
        appendLabelChange: vi.fn(),
      },
      settingsManager: { getBranchSummarySettings: () => ({ reserveTokens: 16_384 }) },
      currentExtensionRunner: {
        hasHandlers: () => false,
        emit: vi.fn(async () => undefined),
      },
      getRequiredRequestAuth: vi.fn(async () => ({ apiKey: "test-key", headers: undefined })),
      emit: (event: AgentSessionEvent) => emittedEvents.push(event),
    };

    const result = await AgentSessionTree.prototype.navigateTree.call(session, target.id, {
      summarize: true,
    });

    expect(result.cancelled).toBe(false);
    expect(emittedEvents).toContainEqual({
      type: "context_usage",
      source: "branch_summary",
      usage,
    });
  });
});

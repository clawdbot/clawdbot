import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../internal-runtime-context.js";
import {
  assembleHarnessContextEngine,
  finalizeHarnessContextEngineTurn,
} from "./context-engine-lifecycle.js";

function textMessage(role: "user" | "assistant", text: string, timestamp: number): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function runtimeContextMessage(content: string, timestamp: number): AgentMessage {
  return {
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    content,
    display: false,
    details: { source: "openclaw-runtime-context" },
    timestamp,
  } as AgentMessage;
}

function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  return {
    info: { id: "test", name: "Test context engine" },
    ingest: vi.fn(async () => ({ ingested: true })),
    assemble: vi.fn(async (params) => ({
      messages: params.messages,
      estimatedTokens: 0,
    })),
    compact: vi.fn(async () => ({ ok: true, compacted: false })),
    ...overrides,
  };
}

const sessionParams = {
  sessionIdUsed: "session-1",
  sessionId: "session-1",
  sessionKey: "agent:main",
  sessionFile: "sessions/main.jsonl",
};

describe("harness context engine lifecycle", () => {
  it("keeps hidden runtime-context custom messages out of assemble hooks", async () => {
    const visibleUser = textMessage("user", "visible ask", 1);
    const hiddenRuntimeContext = runtimeContextMessage("hidden runtime context", 2);
    const visibleAssistant = textMessage("assistant", "visible answer", 3);
    const assemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
    }));

    await assembleHarnessContextEngine({
      contextEngine: createContextEngine({ assemble }),
      sessionId: sessionParams.sessionId,
      sessionKey: sessionParams.sessionKey,
      messages: [visibleUser, hiddenRuntimeContext, visibleAssistant],
      modelId: "gpt-test",
    });

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [visibleUser, visibleAssistant],
      }),
    );
  });

  it("keeps hidden runtime-context custom messages out of afterTurn hooks", async () => {
    const beforePromptUser = textMessage("user", "old ask", 1);
    const beforePromptRuntimeContext = runtimeContextMessage("old hidden context", 2);
    const beforePromptAssistant = textMessage("assistant", "old answer", 3);
    const turnUser = textMessage("user", "new ask", 4);
    const turnRuntimeContext = runtimeContextMessage("new hidden context", 5);
    const turnAssistant = textMessage("assistant", "new answer", 6);
    const afterTurn = vi.fn(async () => {});

    await finalizeHarnessContextEngineTurn({
      contextEngine: createContextEngine({ afterTurn }),
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: sessionParams.sessionIdUsed,
      sessionKey: sessionParams.sessionKey,
      sessionFile: sessionParams.sessionFile,
      messagesSnapshot: [
        beforePromptUser,
        beforePromptRuntimeContext,
        beforePromptAssistant,
        turnUser,
        turnRuntimeContext,
        turnAssistant,
      ],
      prePromptMessageCount: 3,
      tokenBudget: 2048,
      runtimeContext: {},
      runMaintenance: async () => undefined,
      warn: () => {},
    });

    expect(afterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [beforePromptUser, beforePromptAssistant, turnUser, turnAssistant],
        prePromptMessageCount: 2,
      }),
    );
  });

  it("keeps hidden runtime-context custom messages out of ingestBatch fallbacks", async () => {
    const beforePromptUser = textMessage("user", "old ask", 1);
    const beforePromptRuntimeContext = runtimeContextMessage("old hidden context", 2);
    const beforePromptAssistant = textMessage("assistant", "old answer", 3);
    const turnUser = textMessage("user", "new ask", 4);
    const turnRuntimeContext = runtimeContextMessage("new hidden context", 5);
    const turnAssistant = textMessage("assistant", "new answer", 6);
    const ingestBatch = vi.fn(async () => ({ ingestedCount: 2 }));

    await finalizeHarnessContextEngineTurn({
      contextEngine: createContextEngine({ ingestBatch }),
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: sessionParams.sessionIdUsed,
      sessionKey: sessionParams.sessionKey,
      sessionFile: sessionParams.sessionFile,
      messagesSnapshot: [
        beforePromptUser,
        beforePromptRuntimeContext,
        beforePromptAssistant,
        turnUser,
        turnRuntimeContext,
        turnAssistant,
      ],
      prePromptMessageCount: 3,
      tokenBudget: 2048,
      runtimeContext: {},
      runMaintenance: async () => undefined,
      warn: () => {},
    });

    expect(ingestBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [turnUser, turnAssistant],
      }),
    );
  });
});

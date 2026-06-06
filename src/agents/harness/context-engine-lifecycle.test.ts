// Covers context-engine message filtering, assemble validation, and turn finalization.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
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
  // Runtime context is hidden harness metadata. Context engines should see
  // user/assistant transcript messages, not this internal custom channel.
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

    const assembleParams = assemble.mock.calls.at(0)?.[0];
    expect(assembleParams?.messages).toEqual([visibleUser, visibleAssistant]);
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

    const afterTurnCalls = (afterTurn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const afterTurnParams = afterTurnCalls[0]?.[0] as
      | { messages?: AgentMessage[]; prePromptMessageCount?: number }
      | undefined;
    expect(afterTurnParams?.messages).toEqual([
      beforePromptUser,
      beforePromptAssistant,
      turnUser,
      turnAssistant,
    ]);
    expect(afterTurnParams?.prePromptMessageCount).toBe(2);
  });

  describe("assembleHarnessContextEngine result validation", () => {
    // Regression for #75541: plugins that return a malformed assemble result
    // previously poisoned activeSession.messages with `undefined`, which then
    // crashed downstream with "Cannot read properties of undefined (reading
    // 'length')". The harness wrapper now throws a descriptive error so the
    // runner's existing assemble try/catch can log the engine id and fall
    // back to the pipeline messages instead of corrupting session state.
    const visibleUser = textMessage("user", "ping", 1);

    async function runAssembleWithEngineResult(result: unknown) {
      return assembleHarnessContextEngine({
        contextEngine: createContextEngine({
          info: { id: "broken-engine", name: "Broken engine" },
          assemble: vi.fn(async () => result as never),
        }),
        sessionId: sessionParams.sessionId,
        sessionKey: sessionParams.sessionKey,
        messages: [visibleUser],
        modelId: "gpt-test",
      });
    }

    it("passes through a well-formed AssembleResult unchanged", async () => {
      const wellFormed = { messages: [visibleUser], estimatedTokens: 0 };
      await expect(runAssembleWithEngineResult(wellFormed)).resolves.toBe(wellFormed);
    });

    it("rejects an undefined assemble result with the engine id", async () => {
      await expect(runAssembleWithEngineResult(undefined)).rejects.toThrow(
        /context engine "broken-engine"[\s\S]*messages/,
      );
    });

    it("rejects a null assemble result with the engine id", async () => {
      await expect(runAssembleWithEngineResult(null)).rejects.toThrow(
        /context engine "broken-engine"[\s\S]*messages/,
      );
    });

    it("rejects an assemble result missing the messages array (lossless-claw shape)", async () => {
      // Mirrors the malformed shape reported in #75541, where the plugin
      // returned an object that satisfied the truthy `if (!assembled)` guard
      // but omitted the required `messages` field.
      await expect(runAssembleWithEngineResult({ estimatedTokens: 0 })).rejects.toThrow(
        /assemble\(\) returned an invalid result[\s\S]*messages of type undefined/,
      );
    });

    it("rejects an assemble result whose messages field is not an array", async () => {
      await expect(
        runAssembleWithEngineResult({ messages: "all of them", estimatedTokens: 0 }),
      ).rejects.toThrow(/messages of type string/);
    });

    it("rejects an assemble result whose messages field is null", async () => {
      await expect(
        runAssembleWithEngineResult({ messages: null, estimatedTokens: 0 }),
      ).rejects.toThrow(/messages of type null/);
    });
  });

  it("keeps hidden runtime-context custom messages out of ingestBatch fallbacks", async () => {
    const beforePromptUser = textMessage("user", "old ask", 1);
    const beforePromptRuntimeContext = runtimeContextMessage("old hidden context", 2);
    const beforePromptAssistant = textMessage("assistant", "old answer", 3);
    const turnUser = textMessage("user", "new ask", 4);
    const turnRuntimeContext = runtimeContextMessage("new hidden context", 5);
    const turnAssistant = textMessage("assistant", "new answer", 6);
    const ingestBatch = vi.fn(async () => ({ ingestedCount: 2 }));

    // The ingestBatch fallback receives only the current visible turn, with
    // hidden runtime context filtered and the pre-prompt history excluded.
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
      isHeartbeat: true,
    });

    const ingestBatchCalls = (ingestBatch as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const ingestBatchParams = ingestBatchCalls[0]?.[0] as
      | { isHeartbeat?: boolean; messages?: AgentMessage[] }
      | undefined;
    expect(ingestBatchParams?.messages).toEqual([turnUser, turnAssistant]);
    expect(ingestBatchParams?.isHeartbeat).toBe(true);
  });

  it("forwards heartbeat state to per-message ingest fallbacks", async () => {
    const turnUser = textMessage("user", "new ask", 4);
    const turnAssistant = textMessage("assistant", "new answer", 6);
    const ingest = vi.fn(async () => ({ ingested: true }));

    await finalizeHarnessContextEngineTurn({
      contextEngine: createContextEngine({ ingest }),
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: sessionParams.sessionIdUsed,
      sessionKey: sessionParams.sessionKey,
      sessionFile: sessionParams.sessionFile,
      messagesSnapshot: [turnUser, turnAssistant],
      prePromptMessageCount: 0,
      tokenBudget: 2048,
      runtimeContext: {},
      runMaintenance: async () => undefined,
      warn: () => {},
      isHeartbeat: true,
    });

    const ingestCalls = (ingest as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(ingestCalls).toHaveLength(2);
    for (const call of ingestCalls) {
      const ingestParams = call[0] as { isHeartbeat?: boolean };
      expect(ingestParams.isHeartbeat).toBe(true);
    }
  });
});

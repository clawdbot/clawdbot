// Covers context-engine message filtering, assemble validation, and turn finalization.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { buildMemorySystemPromptAddition } from "../../context-engine/delegate.js";
import {
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
} from "../../context-engine/host-compat.js";
import {
  registerContextEngineForOwner,
  resolveContextEngine,
} from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
} from "../../context-engine/types.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptPreparation,
  registerTestMemoryPromptBuilder,
} from "../../plugins/memory-state.test-fixtures.js";
import { compactContextEngineWithSafetyTimeout } from "../embedded-agent-runner/compaction-safety-timeout.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../internal-runtime-context.js";
import {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
  finalizeHarnessContextEngineTurn,
} from "./context-engine-lifecycle.js";

function registerTestContextEngine(
  id: string,
  factory: Parameters<typeof registerContextEngineForOwner>[1],
) {
  return registerContextEngineForOwner(id, factory, `test:${id}`, {
    allowSameOwnerRefresh: true,
  });
}

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

let configuredProofEngineIdCounter = 0;
function uniqueConfiguredProofEngineId() {
  configuredProofEngineIdCounter += 1;
  return `configured-runtime-settings-proof-${configuredProofEngineIdCounter}`;
}

describe("harness context engine lifecycle", () => {
  it("scopes async memory preparation to non-legacy assembly with sandbox context", async () => {
    const prepare = vi.fn(async ({ sandboxed }) => [
      "## Prepared Memory",
      `sandboxed=${sandboxed}`,
      "",
    ]);
    registerTestMemoryPromptBuilder(() => ["## Memory Recall", ""]);
    registerMemoryPromptPreparation("memory-wiki", prepare);
    const availableTools = new Set(["wiki_search"]);
    const assemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
      systemPromptAddition: buildMemorySystemPromptAddition({
        availableTools: params.availableTools ?? new Set(),
        citationsMode: params.citationsMode,
      }),
    }));

    try {
      const result = await assembleHarnessContextEngine({
        contextEngine: createContextEngine({ assemble }),
        sessionId: sessionParams.sessionId,
        sessionKey: "agent:support:main",
        messages: [textMessage("user", "visible ask", 1)],
        availableTools,
        citationsMode: "on",
        sandboxed: true,
        modelId: "gpt-test",
      });

      expect(result?.systemPromptAddition).toBe(
        "## Memory Recall\n\n## Prepared Memory\nsandboxed=true",
      );
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "support",
          agentSessionKey: "agent:support:main",
          sandboxed: true,
        }),
      );
      expect(buildMemorySystemPromptAddition({ availableTools })).toBe("## Memory Recall");
    } finally {
      clearMemoryPluginState();
    }
  });

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

  it("passes declared runtime settings into assemble hooks", async () => {
    const visibleUser = textMessage("user", "visible ask", 1);
    const assemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
    }));

    await assembleHarnessContextEngine({
      contextEngine: createContextEngine({ assemble }),
      sessionId: sessionParams.sessionId,
      sessionKey: sessionParams.sessionKey,
      messages: [visibleUser],
      tokenBudget: 4096,
      modelId: "gpt-5.5",
      providerId: "openai",
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
    });

    const assembleParams = assemble.mock.calls.at(0)?.[0];
    expect(assembleParams?.runtimeSettings).toMatchObject({
      schemaVersion: 1,
      runtime: {
        host: "openclaw",
        mode: "normal",
      },
      model: {
        resolved: "gpt-5.5",
        provider: "openai",
      },
      contextEngineSelection: {
        selectedId: expect.any(String),
        source: "configured",
      },
      executionHost: {
        id: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST.id,
      },
      limits: {
        promptTokenBudget: 4096,
      },
    });
  });

  it("passes runtime settings through a configured context engine across lifecycle hooks", async () => {
    const engineId = uniqueConfiguredProofEngineId();
    const captured: Array<{
      hook: "bootstrap" | "assemble" | "afterTurn" | "maintain" | "compact";
      runtimeContext?: ContextEngineRuntimeContext;
      runtimeSettings?: ContextEngineRuntimeSettings;
      sessionTarget?: ContextEngineRuntimeContext["sessionTarget"];
    }> = [];
    const sessionTarget = {
      agentId: "main",
      sessionId: sessionParams.sessionId,
      sessionKey: sessionParams.sessionKey,
      storePath: "/tmp/state/openclaw.sqlite",
    };
    const bootstrapRuntimeContext = {
      transcriptStorage: { kind: "sqlite" as const },
      sessionTarget,
    };
    const engine = createContextEngine({
      info: { id: engineId, name: "Configured runtime settings proof engine" },
      bootstrap: vi.fn(async (params) => {
        captured.push({
          hook: "bootstrap",
          runtimeContext: params.runtimeContext,
          runtimeSettings: params.runtimeSettings,
          sessionTarget: params.sessionTarget,
        });
        return { bootstrapped: true };
      }),
      assemble: vi.fn(async (params) => {
        captured.push({ hook: "assemble", runtimeSettings: params.runtimeSettings });
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }),
      afterTurn: vi.fn(async (params) => {
        captured.push({
          hook: "afterTurn",
          runtimeSettings: params.runtimeSettings,
          sessionTarget: params.sessionTarget,
        });
      }),
      maintain: vi.fn(async (params) => {
        captured.push({
          hook: "maintain",
          runtimeContext: params.runtimeContext,
          runtimeSettings: params.runtimeSettings,
          sessionTarget: params.sessionTarget,
        });
        return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
      }),
      compact: vi.fn(async (params) => {
        captured.push({ hook: "compact", runtimeSettings: params.runtimeSettings });
        return { ok: true, compacted: false };
      }),
    });
    registerTestContextEngine(engineId, () => engine);
    const configuredEngine = await resolveContextEngine({
      plugins: { slots: { contextEngine: engineId } },
    });

    await bootstrapHarnessContextEngine({
      hadSessionFile: true,
      contextEngine: configuredEngine,
      sessionId: sessionParams.sessionId,
      sessionKey: sessionParams.sessionKey,
      sessionTarget,
      sessionFile: sessionParams.sessionFile,
      providerId: "openai",
      requestedModelId: "openai/gpt-5.5",
      modelId: "anthropic/claude-sonnet-4-6",
      fallbackReason: "primary_provider_5xx",
      runtimeContext: bootstrapRuntimeContext,
      warn: () => {},
    });

    await assembleHarnessContextEngine({
      contextEngine: configuredEngine,
      sessionId: sessionParams.sessionId,
      sessionKey: sessionParams.sessionKey,
      messages: [textMessage("user", "visible ask", 1)],
      tokenBudget: 2048,
      providerId: "openai",
      requestedModelId: "openai/gpt-5.5",
      modelId: "anthropic/claude-sonnet-4-6",
      fallbackReason: "primary_provider_5xx",
    });

    await finalizeHarnessContextEngineTurn({
      contextEngine: configuredEngine,
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: sessionParams.sessionIdUsed,
      sessionKey: sessionParams.sessionKey,
      sessionTarget,
      sessionFile: sessionParams.sessionFile,
      messagesSnapshot: [
        textMessage("user", "old ask", 1),
        textMessage("assistant", "old answer", 2),
        textMessage("user", "new ask", 3),
        textMessage("assistant", "new answer", 4),
      ],
      prePromptMessageCount: 2,
      tokenBudget: 2048,
      providerId: "openai",
      requestedModelId: "openai/gpt-5.5",
      modelId: "anthropic/claude-sonnet-4-6",
      fallbackReason: "primary_provider_5xx",
      warn: () => {},
    });

    const compactRuntimeSettings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      provider: "openai",
      requestedModel: "openai/gpt-5.5",
      resolvedModel: "anthropic/claude-sonnet-4-6",
      selectedContextEngineId: engineId,
      contextEngineSelectionSource: "configured",
      promptTokenBudget: 2048,
      fallbackReason: "primary_provider_5xx",
    });
    await compactContextEngineWithSafetyTimeout(
      configuredEngine,
      {
        sessionId: sessionParams.sessionId,
        sessionKey: sessionParams.sessionKey,
        sessionTarget: {
          sessionId: sessionParams.sessionId,
          sessionKey: sessionParams.sessionKey,
        },
        tokenBudget: 2048,
        runtimeSettings: compactRuntimeSettings,
      },
      100,
    );

    expect(new Set(captured.map((entry) => entry.hook))).toEqual(
      new Set(["bootstrap", "assemble", "afterTurn", "maintain", "compact"]),
    );
    expect(captured.find((entry) => entry.hook === "bootstrap")?.runtimeContext).toEqual(
      bootstrapRuntimeContext,
    );
    expect(captured.find((entry) => entry.hook === "bootstrap")?.sessionTarget).toEqual(
      sessionTarget,
    );
    expect(captured.find((entry) => entry.hook === "afterTurn")?.sessionTarget).toEqual(
      sessionTarget,
    );
    expect(captured.find((entry) => entry.hook === "maintain")?.sessionTarget).toEqual(
      sessionTarget,
    );
    expect(
      captured.find((entry) => entry.hook === "maintain")?.runtimeContext?.sessionTarget,
    ).toEqual(sessionTarget);
    for (const entry of captured) {
      expect(entry.runtimeSettings).toMatchObject({
        schemaVersion: 1,
        runtime: { mode: "fallback" },
        model: {
          requested: "openai/gpt-5.5",
          resolved: "anthropic/claude-sonnet-4-6",
          provider: "openai",
          family: null,
        },
        contextEngineSelection: {
          selectedId: engineId,
          source: "configured",
        },
        diagnostics: {
          fallbackReason: "provider_unavailable",
        },
      });
    }
  });

  it("never derives model.family from the model id (defaults to null)", async () => {
    const assemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
    }));

    await assembleHarnessContextEngine({
      contextEngine: createContextEngine({ assemble }),
      sessionId: sessionParams.sessionId,
      sessionKey: sessionParams.sessionKey,
      messages: [textMessage("user", "ask", 1)],
      modelId: "anthropic/claude-opus-4-8",
      providerId: "anthropic",
    });

    const noFamily = assemble.mock.calls.at(0)?.[0]?.runtimeSettings?.model;
    // Regression: model.family must not mirror the model id.
    expect(noFamily?.resolved).toBe("anthropic/claude-opus-4-8");
    expect(noFamily?.family).toBeNull();

    await assembleHarnessContextEngine({
      contextEngine: createContextEngine({ assemble }),
      sessionId: sessionParams.sessionId,
      sessionKey: sessionParams.sessionKey,
      messages: [textMessage("user", "ask", 1)],
      modelId: "anthropic/claude-opus-4-8",
      providerId: "anthropic",
      modelFamily: "claude",
    });

    const withFamily = assemble.mock.calls.at(1)?.[0]?.runtimeSettings?.model;
    // When a real family is supplied, it is carried through verbatim.
    expect(withFamily?.family).toBe("claude");
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

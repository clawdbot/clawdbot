import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearMemoryPluginState, registerMemoryPromptSection } from "../plugins/memory-state.js";
// ---------------------------------------------------------------------------
// We dynamically import the registry so we can get a fresh module per test
// group when needed.  For most groups we use the shared singleton directly.
// ---------------------------------------------------------------------------
import { buildMemorySystemPromptAddition, delegateCompactionToRuntime } from "./delegate.js";
import { LegacyContextEngine } from "./legacy.js";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import {
  registerContextEngine,
  registerContextEngineForOwner,
  getContextEngineFactory,
  listContextEngineIds,
  resolveContextEngine,
} from "./registry.js";
import type { ContextEngineFactory, ContextEngineRegistrationResult } from "./registry.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  ContextEngineMaintenanceResult,
  IngestResult,
} from "./types.js";

const { compactEmbeddedPiSessionDirectMock } = vi.hoisted(() => ({
  compactEmbeddedPiSessionDirectMock: vi.fn(),
}));

vi.mock("../agents/pi-embedded-runner/compact.runtime.js", () => ({
  compactEmbeddedPiSessionDirect: compactEmbeddedPiSessionDirectMock,
}));

function installCompactRuntimeSpy() {
  return compactEmbeddedPiSessionDirectMock.mockResolvedValue({
    ok: true,
    compacted: false,
    reason: "mock compaction",
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: 0,
      tokensAfter: 0,
      details: undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a config object with a contextEngine slot for testing. */
function configWithSlot(engineId: string): OpenClawConfig {
  return { plugins: { slots: { contextEngine: engineId } } };
}

function makeMockMessage(role: "user" | "assistant" = "user", text = "hello"): AgentMessage {
  return { role, content: text, timestamp: Date.now() } as AgentMessage;
}

function registerPromptTrackingEngine(engineId: string) {
  const calls: Array<Record<string, unknown>> = [];
  registerContextEngine(engineId, () => ({
    info: { id: engineId, name: "Prompt Tracker", version: "0.0.0" },
    async ingest() {
      return { ingested: false };
    },
    async assemble(params) {
      calls.push({ ...params });
      return { messages: params.messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  }));
  return calls;
}

/** A minimal mock engine that satisfies the ContextEngine interface. */
class MockContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "mock",
    name: "Mock Engine",
    version: "0.0.1",
  };

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: MemoryCitationsMode;
  }): Promise<AssembleResult> {
    return {
      messages: params.messages,
      estimatedTokens: 42,
      systemPromptAddition: "mock system addition",
    };
  }

  async compact(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: true,
      reason: "mock compaction",
      result: {
        summary: "mock summary",
        tokensBefore: 100,
        tokensAfter: 50,
      },
    };
  }

  async dispose(): Promise<void> {
    // no-op
  }
}

class LegacySessionKeyStrictEngine implements ContextEngine {
  readonly info: ContextEngineInfo;
  readonly ingestCalls: Array<Record<string, unknown>> = [];
  readonly assembleCalls: Array<Record<string, unknown>> = [];
  readonly compactCalls: Array<Record<string, unknown>> = [];
  readonly maintainCalls: Array<Record<string, unknown>> = [];
  readonly ingestedMessages: AgentMessage[] = [];

  constructor(engineId = "legacy-sessionkey-strict") {
    this.info = {
      id: engineId,
      name: "Legacy SessionKey Strict Engine",
    };
  }

  private rejectSessionKey(params: { sessionKey?: string }): void {
    if (Object.prototype.hasOwnProperty.call(params, "sessionKey")) {
      throw new Error("Unrecognized key(s) in object: 'sessionKey'");
    }
  }

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    this.ingestCalls.push({ ...params });
    this.rejectSessionKey(params);
    this.ingestedMessages.push(params.message);
    return { ingested: true };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: MemoryCitationsMode;
    prompt?: string;
  }): Promise<AssembleResult> {
    this.assembleCalls.push({ ...params });
    this.rejectSessionKey(params);
    return {
      messages: params.messages,
      estimatedTokens: 7,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult> {
    this.compactCalls.push({ ...params });
    this.rejectSessionKey(params);
    return {
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 50,
        tokensAfter: 25,
      },
    };
  }

  async maintain(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<ContextEngineMaintenanceResult> {
    this.maintainCalls.push({ ...params });
    this.rejectSessionKey(params);
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    };
  }
}

class SessionKeyRuntimeErrorEngine implements ContextEngine {
  readonly info: ContextEngineInfo;
  assembleCalls = 0;
  constructor(
    engineId = "sessionkey-runtime-error",
    private readonly errorMessage = "sessionKey lookup failed",
  ) {
    this.info = {
      id: engineId,
      name: "SessionKey Runtime Error Engine",
    };
  }

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  async assemble(_params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    this.assembleCalls += 1;
    throw new Error(this.errorMessage);
  }

  async compact(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: false,
    };
  }
}

class LegacyAssembleStrictEngine implements ContextEngine {
  readonly info: ContextEngineInfo;
  readonly assembleCalls: Array<Record<string, unknown>> = [];

  constructor(engineId = "legacy-assemble-strict") {
    this.info = {
      id: engineId,
      name: "Legacy Assemble Strict Engine",
    };
  }

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: MemoryCitationsMode;
    prompt?: string;
  }): Promise<AssembleResult> {
    this.assembleCalls.push({ ...params });
    if (Object.prototype.hasOwnProperty.call(params, "sessionKey")) {
      throw new Error("Unrecognized key(s) in object: 'sessionKey'");
    }
    if (Object.prototype.hasOwnProperty.call(params, "prompt")) {
      throw new Error("Unrecognized key(s) in object: 'prompt'");
    }
    return {
      messages: params.messages,
      estimatedTokens: 3,
    };
  }

  async compact(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Engine contract tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Engine contract tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    compactEmbeddedPiSessionDirectMock.mockReset();
    clearMemoryPluginState();
  });

  it("a mock engine implementing ContextEngine can be registered and resolved", async () => {
    const factory = () => new MockContextEngine();
    registerContextEngine("mock", factory);

    const resolved = getContextEngineFactory("mock");
    expect(resolved).toBe(factory);

    const engine = await resolved!();
    expect(engine).toBeInstanceOf(MockContextEngine);
    expect(engine.info.id).toBe("mock");
  });

  it("legacy compact preserves runtimeContext currentTokenCount when top-level value is absent", async () => {
    const compactRuntimeSpy = installCompactRuntimeSpy();
    const engine = new LegacyContextEngine();

    await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/session.json",
      runtimeContext: {
        workspaceDir: "/tmp/workspace",
        currentTokenCount: 277403,
      },
    });

    expect(compactRuntimeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTokenCount: 277403,
      }),
    );
  });

  it("delegateCompactionToRuntime reuses the legacy runtime bridge", async () => {
    const compactRuntimeSpy = installCompactRuntimeSpy();
    const result = await delegateCompactionToRuntime({
      sessionId: "s2",
      sessionFile: "/tmp/session.json",
      tokenBudget: 4096,
      runtimeContext: {
        workspaceDir: "/tmp/workspace",
        currentTokenCount: 12345,
      },
    });

    expect(compactRuntimeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s2",
        sessionFile: "/tmp/session.json",
        tokenBudget: 4096,
        currentTokenCount: 12345,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(result).toEqual({
      ok: true,
      compacted: false,
      reason: "mock compaction",
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: 0,
        tokensAfter: 0,
        details: undefined,
      },
    });
  });

  it("builds a normalized memory system prompt addition from the active memory prompt path", () => {
    registerMemoryPromptSection(({ citationsMode }) => [
      "## Memory Recall",
      `citations=${citationsMode ?? "auto"}`,
      "",
    ]);

    expect(
      buildMemorySystemPromptAddition({
        availableTools: new Set(["memory_search"]),
        citationsMode: "off",
      }),
    ).toBe("## Memory Recall\ncitations=off");
  });

  it("returns undefined when the active memory prompt path contributes nothing", () => {
    expect(
      buildMemorySystemPromptAddition({
        availableTools: new Set(["memory_search"]),
      }),
    ).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Registry tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Registry tests", () => {
  it("registerContextEngine() stores retrievable factories", () => {
    const factory = () => new MockContextEngine();
    registerContextEngine("reg-test-2", factory);

    const retrieved = getContextEngineFactory("reg-test-2");
    expect(retrieved).toBe(factory);
    expect(typeof retrieved).toBe("function");
  });

  it("listContextEngineIds() returns all registered ids", () => {
    // Ensure at least our test entries exist
    registerContextEngine("reg-test-a", () => new MockContextEngine());
    registerContextEngine("reg-test-b", () => new MockContextEngine());

    const ids = listContextEngineIds();
    expect(ids).toContain("reg-test-a");
    expect(ids).toContain("reg-test-b");
    expect(Array.isArray(ids)).toBe(true);
  });

  it("registering the same id with the same owner refreshes the factory", () => {
    const factory1 = () => new MockContextEngine();
    const factory2 = () => new MockContextEngine();

    expect(
      registerContextEngineForOwner("reg-overwrite", factory1, "owner-a", {
        allowSameOwnerRefresh: true,
      }),
    ).toEqual({ ok: true });
    expect(getContextEngineFactory("reg-overwrite")).toBe(factory1);

    expect(
      registerContextEngineForOwner("reg-overwrite", factory2, "owner-a", {
        allowSameOwnerRefresh: true,
      }),
    ).toEqual({ ok: true });
    expect(getContextEngineFactory("reg-overwrite")).toBe(factory2);
    expect(getContextEngineFactory("reg-overwrite")).not.toBe(factory1);
  });

  it("rejects context engine registrations from a different owner", () => {
    const factory1 = () => new MockContextEngine();
    const factory2 = () => new MockContextEngine();

    expect(
      registerContextEngineForOwner("reg-owner-guard", factory1, "owner-a", {
        allowSameOwnerRefresh: true,
      }),
    ).toEqual({ ok: true });
    expect(registerContextEngineForOwner("reg-owner-guard", factory2, "owner-b")).toEqual({
      ok: false,
      existingOwner: "owner-a",
    });
    expect(getContextEngineFactory("reg-owner-guard")).toBe(factory1);
  });

  it("public registerContextEngine cannot spoof owner or refresh existing ids", () => {
    const ownedFactory = () => new MockContextEngine();
    expect(
      registerContextEngineForOwner("public-owner-guard", ownedFactory, "owner-a", {
        allowSameOwnerRefresh: true,
      }),
    ).toEqual({ ok: true });

    const spoofAttempt = (
      registerContextEngine as unknown as (
        id: string,
        factory: ContextEngineFactory,
        opts?: { owner?: string },
      ) => ContextEngineRegistrationResult
    )("public-owner-guard", () => new MockContextEngine(), { owner: "owner-a" });

    expect(spoofAttempt).toEqual({
      ok: false,
      existingOwner: "owner-a",
    });
    expect(getContextEngineFactory("public-owner-guard")).toBe(ownedFactory);
  });

  it("public registerContextEngine reserves the default legacy id", () => {
    const legacyAttempt = (
      registerContextEngine as unknown as (
        id: string,
        factory: ContextEngineFactory,
        opts?: { owner?: string },
      ) => ContextEngineRegistrationResult
    )("legacy", () => new MockContextEngine(), { owner: "core" });

    expect(legacyAttempt).toEqual({
      ok: false,
      existingOwner: "core",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Default engine selection
// ═══════════════════════════════════════════════════════════════════════════

describe("Legacy sessionKey compatibility", () => {
  it("memoizes legacy mode after the first strict compatibility retry", async () => {
    const engineId = `legacy-sessionkey-${Date.now().toString(36)}`;
    const strictEngine = new LegacySessionKeyStrictEngine(engineId);
    registerContextEngine(engineId, () => strictEngine);

    const engine = await resolveContextEngine(configWithSlot(engineId));
    const firstAssembled = await engine.assemble({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      messages: [makeMockMessage()],
    });
    const compacted = await engine.compact({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      sessionFile: "/tmp/session.json",
    });

    expect(firstAssembled.estimatedTokens).toBe(7);
    expect(compacted.compacted).toBe(true);
    expect(strictEngine.assembleCalls).toHaveLength(2);
    expect(strictEngine.assembleCalls[0]).toHaveProperty("sessionKey", "agent:main:test");
    expect(strictEngine.assembleCalls[1]).not.toHaveProperty("sessionKey");
    expect(strictEngine.compactCalls).toHaveLength(1);
    expect(strictEngine.compactCalls[0]).not.toHaveProperty("sessionKey");
  });

  it("retries strict ingest once and ingests each message only once", async () => {
    const engineId = `legacy-sessionkey-ingest-${Date.now().toString(36)}`;
    const strictEngine = new LegacySessionKeyStrictEngine(engineId);
    registerContextEngine(engineId, () => strictEngine);

    const engine = await resolveContextEngine(configWithSlot(engineId));
    const firstMessage = makeMockMessage("user", "first");
    const secondMessage = makeMockMessage("assistant", "second");

    await engine.ingest({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      message: firstMessage,
    });
    await engine.ingest({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      message: secondMessage,
    });

    expect(strictEngine.ingestCalls).toHaveLength(3);
    expect(strictEngine.ingestCalls[0]).toHaveProperty("sessionKey", "agent:main:test");
    expect(strictEngine.ingestCalls[1]).not.toHaveProperty("sessionKey");
    expect(strictEngine.ingestCalls[2]).not.toHaveProperty("sessionKey");
    expect(strictEngine.ingestedMessages).toEqual([firstMessage, secondMessage]);
  });

  it("retries strict maintain once and memoizes legacy mode there too", async () => {
    const engineId = `legacy-sessionkey-maintain-${Date.now().toString(36)}`;
    const strictEngine = new LegacySessionKeyStrictEngine(engineId);
    registerContextEngine(engineId, () => strictEngine);

    const engine = await resolveContextEngine(configWithSlot(engineId));

    await engine.maintain?.({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      sessionFile: "/tmp/session.json",
    });

    expect(strictEngine.maintainCalls).toHaveLength(2);
    expect(strictEngine.maintainCalls[0]).toHaveProperty("sessionKey", "agent:main:test");
    expect(strictEngine.maintainCalls[1]).not.toHaveProperty("sessionKey");
  });

  it("does not retry non-compat runtime errors", async () => {
    const engineId = `sessionkey-runtime-${Date.now().toString(36)}`;
    const runtimeErrorEngine = new SessionKeyRuntimeErrorEngine(engineId);
    registerContextEngine(engineId, () => runtimeErrorEngine);

    const engine = await resolveContextEngine(configWithSlot(engineId));

    await expect(
      engine.assemble({
        sessionId: "s1",
        sessionKey: "agent:main:test",
        messages: [makeMockMessage()],
      }),
    ).rejects.toThrow("sessionKey lookup failed");
    expect(runtimeErrorEngine.assembleCalls).toBe(1);
  });

  it("does not treat 'Unknown sessionKey' runtime failures as schema-compat errors", async () => {
    const engineId = `sessionkey-unknown-runtime-${Date.now().toString(36)}`;
    const runtimeErrorEngine = new SessionKeyRuntimeErrorEngine(
      engineId,
      'Unknown sessionKey "agent:main:missing"',
    );
    registerContextEngine(engineId, () => runtimeErrorEngine);

    const engine = await resolveContextEngine(configWithSlot(engineId));

    await expect(
      engine.assemble({
        sessionId: "s1",
        sessionKey: "agent:main:missing",
        messages: [makeMockMessage()],
      }),
    ).rejects.toThrow('Unknown sessionKey "agent:main:missing"');
    expect(runtimeErrorEngine.assembleCalls).toBe(1);
  });
});

describe("Default engine selection", () => {
  // Ensure both legacy and a custom test engine are registered before these tests.
  beforeEach(() => {
    // Registration is idempotent (Map.set), so calling again is safe.
    registerLegacyContextEngine();
    // Register a lightweight custom stub so we don't need external resources.
    registerContextEngine("test-engine", () => {
      const engine: ContextEngine = {
        info: { id: "test-engine", name: "Custom Test Engine", version: "0.0.0" },
        async ingest() {
          return { ingested: true };
        },
        async assemble({ messages }) {
          return { messages, estimatedTokens: 0 };
        },
        async compact() {
          return { ok: true, compacted: false };
        },
      };
      return engine;
    });
  });

  it("resolveContextEngine() with no config returns the default ('legacy') engine", async () => {
    const engine = await resolveContextEngine();
    expect(engine.info.id).toBe("legacy");
  });

  it("resolveContextEngine() with config contextEngine='legacy' returns legacy engine", async () => {
    const engine = await resolveContextEngine(configWithSlot("legacy"));
    expect(engine.info.id).toBe("legacy");
  });

  it("resolveContextEngine() with config contextEngine='test-engine' returns the custom engine", async () => {
    const engine = await resolveContextEngine(configWithSlot("test-engine"));
    expect(engine.info.id).toBe("test-engine");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Invalid engine fallback
// ═══════════════════════════════════════════════════════════════════════════

describe("Invalid engine fallback", () => {
  beforeEach(() => {
    registerLegacyContextEngine();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to default engine when requested engine is not registered", async () => {
    const engine = await resolveContextEngine(configWithSlot("does-not-exist"));
    expect(engine.info.id).toBe("legacy");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("does-not-exist"));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("falling back to default engine"),
    );
  });

  it("throws when the default engine itself is not registered", async () => {
    // Access the process-global registry via the well-known symbol and clear it
    // so even the default engine is missing. The symbol key must match the
    // private CONTEXT_ENGINE_REGISTRY_STATE constant in registry.ts — guard
    // against a silent key mismatch so a rename surfaces loudly.
    const registryState = (globalThis as Record<symbol, unknown>)[
      Symbol.for("openclaw.contextEngineRegistryState")
    ] as { engines: Map<string, unknown> } | undefined;
    expect(registryState).toBeDefined();
    const snapshot = new Map(registryState!.engines);
    registryState!.engines.clear();

    try {
      await expect(resolveContextEngine()).rejects.toThrow("not registered");
    } finally {
      for (const [key, value] of snapshot) {
        registryState!.engines.set(key, value);
      }
    }
  });

  it("propagates error when default engine factory throws", async () => {
    // Override the default "legacy" engine with a throwing factory via the
    // core-owner path so the registration is accepted.
    registerContextEngineForOwner(
      "legacy",
      () => {
        throw new Error("default engine init failed");
      },
      "core",
      { allowSameOwnerRefresh: true },
    );

    await expect(resolveContextEngine()).rejects.toThrow("default engine init failed");
  });

  it("propagates error when default engine fails contract validation", async () => {
    registerContextEngineForOwner(
      "legacy",
      () => ({ broken: true }) as unknown as ContextEngine,
      "core",
      { allowSameOwnerRefresh: true },
    );

    await expect(resolveContextEngine()).rejects.toThrow(
      'Context engine "legacy" factory returned an invalid ContextEngine',
    );
  });

  it("falls back to default engine when factory throws", async () => {
    const engineId = `factory-throw-${Date.now().toString(36)}`;
    registerContextEngine(engineId, () => {
      throw new Error("plugin version mismatch");
    });

    const engine = await resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe("legacy");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("plugin version mismatch"));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("falling back to default engine"),
    );
  });

  it("falls back to default engine when resolved engine omits info metadata", async () => {
    const engineId = `invalid-info-${Date.now().toString(36)}`;
    registerContextEngine(
      engineId,
      () =>
        ({
          async ingest() {
            return { ingested: false };
          },
          async assemble({ messages }: { messages: AgentMessage[] }) {
            return { messages, estimatedTokens: 0 };
          },
          async compact() {
            return { ok: true, compacted: false };
          },
        }) as unknown as ContextEngine,
    );

    const engine = await resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe("legacy");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("missing info"));
  });

  it("falls back to default engine when info.id mismatches the registered id", async () => {
    const engineId = `mismatched-info-id-${Date.now().toString(36)}`;
    registerContextEngine(
      engineId,
      () =>
        ({
          info: { id: "legacy", name: "Broken Engine" },
          async ingest() {
            return { ingested: false };
          },
          async assemble({ messages }: { messages: AgentMessage[] }) {
            return { messages, estimatedTokens: 0 };
          },
          async compact() {
            return { ok: true, compacted: false };
          },
        }) as unknown as ContextEngine,
    );

    const engine = await resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe("legacy");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`info.id must match registered id "${engineId}"`),
    );
  });

  it("falls back to default engine when resolved engine omits lifecycle methods", async () => {
    const engineId = `invalid-methods-${Date.now().toString(36)}`;
    registerContextEngine(
      engineId,
      () =>
        ({
          info: { id: engineId, name: "Broken Engine" },
          async ingest() {
            return { ingested: false };
          },
        }) as unknown as ContextEngine,
    );

    const engine = await resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe("legacy");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("missing assemble(), missing compact()"),
    );
  });

  it("falls back to default engine when contract validation itself throws", async () => {
    const engineId = `validation-throw-${Date.now().toString(36)}`;
    // BigInt cannot be JSON.stringify'd — triggers a throw inside
    // describeResolvedContextEngineContractError when the factory returns
    // a non-object value that passes the typeof !== "object" branch.
    registerContextEngine(engineId, () => 42n as unknown as ContextEngine);

    const engine = await resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe("legacy");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("contract validation threw"),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. LegacyContextEngine parity
// ═══════════════════════════════════════════════════════════════════════════

describe("LegacyContextEngine parity", () => {
  it("ingest() returns { ingested: false } (no-op)", async () => {
    const engine = new LegacyContextEngine();
    const result = await engine.ingest({
      sessionId: "s1",
      message: makeMockMessage(),
    });

    expect(result).toEqual({ ingested: false });
  });

  it("assemble() returns messages as-is (pass-through)", async () => {
    const engine = new LegacyContextEngine();
    const messages = [
      makeMockMessage("user", "first"),
      makeMockMessage("assistant", "second"),
      makeMockMessage("user", "third"),
    ];

    const result = await engine.assemble({
      sessionId: "s1",
      messages,
    });

    // Messages should be the exact same array reference (pass-through)
    expect(result.messages).toBe(messages);
    expect(result.messages).toHaveLength(3);
    expect(result.estimatedTokens).toBe(0);
    expect(result.systemPromptAddition).toBeUndefined();
  });

  it("dispose() completes without error", async () => {
    const engine = new LegacyContextEngine();
    await expect(engine.dispose()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5b. assemble() prompt forwarding
// ═══════════════════════════════════════════════════════════════════════════

describe("assemble() prompt forwarding", () => {
  it("forwards prompt to the underlying engine", async () => {
    const engineId = `prompt-fwd-${Date.now().toString(36)}`;
    const calls = registerPromptTrackingEngine(engineId);

    const engine = await resolveContextEngine(configWithSlot(engineId));
    await engine.assemble({
      sessionId: "s1",
      messages: [makeMockMessage("user", "hello")],
      prompt: "hello",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveProperty("prompt", "hello");
  });

  it("omits prompt when not provided", async () => {
    const engineId = `prompt-omit-${Date.now().toString(36)}`;
    const calls = registerPromptTrackingEngine(engineId);

    const engine = await resolveContextEngine(configWithSlot(engineId));
    await engine.assemble({
      sessionId: "s1",
      messages: [makeMockMessage("user", "hello")],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("prompt");
  });

  it("does not leak prompt key when caller spreads undefined", async () => {
    // Guards against the pattern `{ prompt: params.prompt }` when params.prompt
    // is undefined — JavaScript keeps the key present with value undefined,
    // which breaks engines that guard with `'prompt' in params`.
    const engineId = `prompt-undef-${Date.now().toString(36)}`;
    const calls = registerPromptTrackingEngine(engineId);

    const engine = await resolveContextEngine(configWithSlot(engineId));
    // Simulate the attempt.ts call-site pattern: conditional spread
    const callerPrompt: string | undefined = undefined;
    await engine.assemble({
      sessionId: "s1",
      messages: [makeMockMessage("user", "hello")],
      ...(callerPrompt !== undefined ? { prompt: callerPrompt } : {}),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("prompt");
    expect(Object.keys(calls[0] as object)).not.toContain("prompt");
  });

  it("retries strict legacy assemble without sessionKey and prompt", async () => {
    const engineId = `prompt-legacy-${Date.now().toString(36)}`;
    const strictEngine = new LegacyAssembleStrictEngine(engineId);
    registerContextEngine(engineId, () => strictEngine);

    const engine = await resolveContextEngine(configWithSlot(engineId));
    const result = await engine.assemble({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      messages: [makeMockMessage("user", "hello")],
      prompt: "hello",
    });

    expect(result.estimatedTokens).toBe(3);
    expect(strictEngine.assembleCalls).toHaveLength(3);
    expect(strictEngine.assembleCalls[0]).toHaveProperty("sessionKey", "agent:main:test");
    expect(strictEngine.assembleCalls[0]).toHaveProperty("prompt", "hello");
    expect(strictEngine.assembleCalls[1]).not.toHaveProperty("sessionKey");
    expect(strictEngine.assembleCalls[1]).toHaveProperty("prompt", "hello");
    expect(strictEngine.assembleCalls[2]).not.toHaveProperty("sessionKey");
    expect(strictEngine.assembleCalls[2]).not.toHaveProperty("prompt");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Initialization guard
// ═══════════════════════════════════════════════════════════════════════════

describe("Initialization guard", () => {
  it("ensureContextEnginesInitialized() is idempotent and registers legacy", async () => {
    const { ensureContextEnginesInitialized } = await import("./init.js");

    expect(() => ensureContextEnginesInitialized()).not.toThrow();
    expect(() => ensureContextEnginesInitialized()).not.toThrow();

    const ids = listContextEngineIds();
    expect(ids).toContain("legacy");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Bundle chunk isolation (#40096)
//
// Published builds may split the context-engine registry across multiple
// output chunks.  The Symbol.for() keyed global ensures that a plugin
// calling registerContextEngine() from chunk A is visible to
// resolveContextEngine() imported from chunk B.
//
// These tests exercise the invariant that failed in 2026.3.7 when
// lossless-claw registered successfully but resolution could not find it.
// ═══════════════════════════════════════════════════════════════════════════

describe("Bundle chunk isolation (#40096)", () => {
  it("shares registrations and keeps concurrent chunk registration visible", async () => {
    const ts = Date.now().toString(36);
    const registryUrl = new URL("./registry.ts", import.meta.url).href;
    const chunks = await Promise.all(
      Array.from(
        { length: 3 },
        (_, i) => import(/* @vite-ignore */ `${registryUrl}?chunk=${ts}-${i}`),
      ),
    );

    const engineId = `cross-chunk-${ts}`;
    const factory = () => ({
      info: { id: engineId, name: "Cross-chunk Engine", version: "0.0.1" },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }: { messages: AgentMessage[] }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
    });
    chunks[0].registerContextEngine(engineId, factory);

    expect(chunks[1].getContextEngineFactory(engineId)).toBe(factory);
    expect(chunks[1].listContextEngineIds()).toContain(engineId);
    const engine = await chunks[1].resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe(engineId);

    const ids = chunks.map((_, i) => `concurrent-${ts}-${i}`);
    const registrationTasks = chunks.map((chunk, i) =>
      Promise.resolve().then(() => {
        const id = `concurrent-${ts}-${i}`;
        chunk.registerContextEngine(id, () => new MockContextEngine());
      }),
    );
    await Promise.all(registrationTasks);

    const allIds = chunks[0].listContextEngineIds();
    for (const id of ids) {
      expect(allIds).toContain(id);
    }
  });
});

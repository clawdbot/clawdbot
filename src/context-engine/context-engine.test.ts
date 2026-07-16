// Context engine tests cover context extraction and prompt context assembly.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptSection,
} from "../plugins/memory-state.test-fixtures.js";
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
  getContextEngineRegistration,
  listContextEngineQuarantines,
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "./registry.js";
import type { ContextEngineFactory, ContextEngineFactoryContext } from "./registry.js";
import { resetContextEngineRuntimeQuarantineForTests } from "./registry.test-support.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineSessionTarget,
  AssembleResult,
  CompactResult,
  ContextEngineMaintenanceResult,
  BootstrapResult,
  IngestResult,
} from "./types.js";

const { compactEmbeddedAgentSessionDirectMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionDirectMock: vi.fn(),
}));

vi.mock("../agents/embedded-agent-runner/compact.runtime.js", () => ({
  compactEmbeddedAgentSessionDirect: compactEmbeddedAgentSessionDirectMock,
}));

function installCompactRuntimeSpy() {
  return compactEmbeddedAgentSessionDirectMock.mockResolvedValue({
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

function requireCompactRuntimeParams(callIndex: number): Record<string, unknown> {
  const params = compactEmbeddedAgentSessionDirectMock.mock.calls[callIndex]?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!params) {
    throw new Error(`missing compact runtime call ${callIndex}`);
  }
  return params;
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

let uniqueEngineIdCounter = 0;
function uniqueEngineId(prefix: string): string {
  uniqueEngineIdCounter += 1;
  return `${prefix}-${uniqueEngineIdCounter}`;
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

function requireFactoryContext(
  context: ContextEngineFactoryContext | undefined,
): ContextEngineFactoryContext {
  if (!context) {
    throw new Error("expected context engine factory context");
  }
  return context;
}

function requireRegistryState() {
  const registryState = (globalThis as Record<symbol, unknown>)[
    Symbol.for("openclaw.contextEngineRegistryState")
  ] as { engines: Map<string, unknown> } | undefined;
  if (!registryState) {
    throw new Error("expected context engine registry state");
  }
  return registryState;
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
    sessionKey: string;
    agentId?: string;
    sessionTarget?: ContextEngineSessionTarget;
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
    if (Object.hasOwn(params, "sessionKey")) {
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
    sessionKey: string;
    agentId?: string;
    sessionTarget?: ContextEngineSessionTarget;
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
    sessionKey: string;
    agentId?: string;
    sessionTarget?: ContextEngineSessionTarget;
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
    runtimeSettings?: unknown;
  }): Promise<AssembleResult> {
    this.assembleCalls.push({ ...params });
    if (Object.hasOwn(params, "sessionKey")) {
      throw new Error("Unrecognized key(s) in object: 'sessionKey'");
    }
    if (Object.hasOwn(params, "prompt")) {
      throw new Error("Unrecognized key(s) in object: 'prompt'");
    }
    if (Object.hasOwn(params, "runtimeSettings")) {
      throw new Error("Unrecognized key(s) in object: 'runtimeSettings'");
    }
    return {
      messages: params.messages,
      estimatedTokens: 3,
    };
  }

  async compact(_params: {
    sessionId: string;
    sessionKey: string;
    agentId?: string;
    sessionTarget?: ContextEngineSessionTarget;
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

class LegacyRuntimeSettingsStrictEngine implements ContextEngine {
  readonly info: ContextEngineInfo;
  readonly bootstrapCalls: Array<Record<string, unknown>> = [];
  readonly maintainCalls: Array<Record<string, unknown>> = [];
  readonly afterTurnCalls: Array<Record<string, unknown>> = [];
  readonly assembleCalls: Array<Record<string, unknown>> = [];
  readonly compactCalls: Array<Record<string, unknown>> = [];

  constructor(engineId = "legacy-runtime-settings-strict") {
    this.info = {
      id: engineId,
      name: "Legacy Runtime Settings Strict Engine",
    };
  }

  private rejectLegacyCompatFields(params: Record<string, unknown>): void {
    if (Object.hasOwn(params, "runtimeSettings")) {
      throw new Error("Unrecognized key(s) in object: 'runtimeSettings'");
    }
    if (Object.hasOwn(params, "sessionTarget")) {
      throw new Error("Unrecognized key(s) in object: 'sessionTarget'");
    }
    if (Object.hasOwn(params, "runtimeContext")) {
      throw new Error("Unrecognized key(s) in object: 'runtimeContext'");
    }
  }

  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    runtimeSettings?: unknown;
    sessionTarget?: ContextEngineSessionTarget;
    runtimeContext?: unknown;
  }): Promise<BootstrapResult> {
    this.bootstrapCalls.push({ ...params });
    this.rejectLegacyCompatFields(params);
    return { bootstrapped: true };
  }

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  async maintain(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    runtimeSettings?: unknown;
    sessionTarget?: ContextEngineSessionTarget;
    runtimeContext?: unknown;
  }): Promise<ContextEngineMaintenanceResult> {
    this.maintainCalls.push({ ...params });
    this.rejectLegacyCompatFields(params);
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    runtimeSettings?: unknown;
    sessionTarget?: ContextEngineSessionTarget;
    runtimeContext?: unknown;
  }): Promise<void> {
    this.afterTurnCalls.push({ ...params });
    this.rejectLegacyCompatFields(params);
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    runtimeSettings?: unknown;
  }): Promise<AssembleResult> {
    this.assembleCalls.push({ ...params });
    this.rejectLegacyCompatFields(params);
    return { messages: params.messages, estimatedTokens: 3 };
  }

  async compact(params: {
    sessionId: string;
    sessionKey: string;
    agentId?: string;
    sessionTarget?: ContextEngineSessionTarget;
    runtimeSettings?: unknown;
    runtimeContext?: unknown;
  }): Promise<CompactResult> {
    this.compactCalls.push({ ...params });
    this.rejectLegacyCompatFields(params);
    return { ok: true, compacted: false };
  }
}

class LegacyRuntimeThenAssembleStrictEngine implements ContextEngine {
  readonly info: ContextEngineInfo;
  readonly maintainCalls: Array<Record<string, unknown>> = [];
  readonly assembleCalls: Array<Record<string, unknown>> = [];

  constructor(engineId = "legacy-runtime-then-assemble-strict") {
    this.info = {
      id: engineId,
      name: "Legacy Runtime Then Assemble Strict Engine",
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

  async maintain(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    runtimeSettings?: unknown;
  }): Promise<ContextEngineMaintenanceResult> {
    this.maintainCalls.push({ ...params });
    if (Object.hasOwn(params, "runtimeSettings")) {
      throw new Error("Unrecognized key(s) in object: 'runtimeSettings'");
    }
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    prompt?: string;
    runtimeSettings?: unknown;
  }): Promise<AssembleResult> {
    this.assembleCalls.push({ ...params });
    if (Object.hasOwn(params, "sessionKey")) {
      throw new Error("Unrecognized key(s) in object: 'sessionKey'");
    }
    if (Object.hasOwn(params, "prompt")) {
      throw new Error("Unrecognized key(s) in object: 'prompt'");
    }
    if (Object.hasOwn(params, "runtimeSettings")) {
      throw new Error("Unrecognized key(s) in object: 'runtimeSettings'");
    }
    return { messages: params.messages, estimatedTokens: 5 };
  }

  async compact(_params: {
    sessionId: string;
    sessionKey: string;
    agentId?: string;
    sessionTarget?: ContextEngineSessionTarget;
  }): Promise<CompactResult> {
    return { ok: true, compacted: false };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Engine contract tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Engine contract tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    compactEmbeddedAgentSessionDirectMock.mockReset();
    clearMemoryPluginState();
  });

  it("a mock engine implementing ContextEngine can be registered and resolved", async () => {
    const factory = () => new MockContextEngine();
    registerContextEngine("mock", factory);

    const engine = await resolveContextEngine(configWithSlot("mock"));
    expect(engine).toBeInstanceOf(MockContextEngine);
    expect(engine.info.id).toBe("mock");
  });

  it("legacy compact preserves runtimeContext currentTokenCount when top-level value is absent", async () => {
    const compactRuntimeSpy = installCompactRuntimeSpy();
    const engine = new LegacyContextEngine();

    await engine.compact({
      sessionId: "s1",
      sessionKey: "agent:main:s1",
      sessionTarget: { agentId: "main", sessionId: "s1", sessionKey: "agent:main:s1" },
      runtimeContext: {
        workspaceDir: "/tmp/workspace",
        currentTokenCount: 277403,
      },
    });

    expect(compactRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(requireCompactRuntimeParams(0).currentTokenCount).toBe(277403);
  });

  it("delegateCompactionToRuntime reuses the legacy runtime bridge", async () => {
    const compactRuntimeSpy = installCompactRuntimeSpy();
    const sessionTarget = {
      agentId: "main",
      sessionId: "s2",
      sessionKey: "agent:main:s2",
      storePath: "/tmp/openclaw-agent.sqlite",
    };
    const result = await delegateCompactionToRuntime({
      sessionId: "s2",
      sessionKey: "agent:main:s2",
      sessionTarget,
      tokenBudget: 4096,
      runtimeContext: {
        workspaceDir: "/tmp/workspace",
        currentTokenCount: 12345,
      },
    });

    expect(compactRuntimeSpy).toHaveBeenCalledTimes(1);
    const compactRuntimeParams = requireCompactRuntimeParams(0);
    expect(compactRuntimeParams.sessionId).toBe("s2");
    expect(compactRuntimeParams.sessionKey).toBe("agent:main:s2");
    expect(compactRuntimeParams.sessionTarget).toEqual(sessionTarget);
    expect(compactRuntimeParams).not.toHaveProperty("sessionFile");
    expect(compactRuntimeParams.tokenBudget).toBe(4096);
    expect(compactRuntimeParams.currentTokenCount).toBe(12345);
    expect(compactRuntimeParams.workspaceDir).toBe("/tmp/workspace");
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

  it("delegateCompactionToRuntime returns successor sessionTarget without sessionFile", async () => {
    compactEmbeddedAgentSessionDirectMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      reason: undefined,
      result: {
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
        tokensAfter: 40,
        details: undefined,
        sessionId: "s3-successor",
        sessionFile: "sqlite:main:s3-successor:/tmp/openclaw-agent.sqlite",
      },
    });

    const result = await delegateCompactionToRuntime({
      sessionId: "s3",
      sessionKey: "agent:main:s3",
      tokenBudget: 4096,
      runtimeContext: {
        workspaceDir: "/tmp/workspace",
      },
    });

    expect(result.result).toMatchObject({
      sessionId: "s3-successor",
      sessionTarget: {
        agentId: "main",
        sessionId: "s3-successor",
        sessionKey: "agent:main:s3",
        storePath: "/tmp/openclaw-agent.sqlite",
      },
    });
    expect(result.result).not.toHaveProperty("sessionFile");
  });

  it("delegateCompactionToRuntime forwards the caller abortSignal to the runtime (#89868)", async () => {
    installCompactRuntimeSpy();
    const controller = new AbortController();
    await delegateCompactionToRuntime({
      sessionId: "s-abort",
      sessionKey: "agent:main:s-abort",
      tokenBudget: 4096,
      abortSignal: controller.signal,
    });

    const compactRuntimeParams = requireCompactRuntimeParams(0);
    expect(compactRuntimeParams.abortSignal).toBe(controller.signal);
  });

  it("delegateCompactionToRuntime passes undefined abortSignal when none supplied", async () => {
    installCompactRuntimeSpy();
    await delegateCompactionToRuntime({
      sessionId: "s-no-abort",
      sessionKey: "agent:main:s-no-abort",
      tokenBudget: 4096,
    });

    const compactRuntimeParams = requireCompactRuntimeParams(0);
    expect(compactRuntimeParams.abortSignal).toBeUndefined();
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

  it("passes agent context through delegated memory prompt assembly", () => {
    registerMemoryPromptSection(({ agentId, agentSessionKey, sandboxed }) => [
      "## Agent Memory",
      `agent=${agentId} session=${agentSessionKey} sandboxed=${sandboxed}`,
      "",
    ]);

    expect(
      buildMemorySystemPromptAddition({
        availableTools: new Set(["memory_search", "memory_get"]),
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      }),
    ).toBe(
      "## Agent Memory\nagent=marketing-agent session=agent:marketing-agent:main sandboxed=true",
    );
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

    expect(getContextEngineRegistration("reg-test-2")?.factory).toBe(factory);
  });

  it("tracks all registered ids", () => {
    registerContextEngine("reg-test-a", () => new MockContextEngine());
    registerContextEngine("reg-test-b", () => new MockContextEngine());

    expect(getContextEngineRegistration("reg-test-a")).toBeDefined();
    expect(getContextEngineRegistration("reg-test-b")).toBeDefined();
  });

  it("registering the same id with the same owner refreshes the factory", () => {
    const factory1 = () => new MockContextEngine();
    const factory2 = () => new MockContextEngine();

    expect(
      registerContextEngineForOwner("reg-overwrite", factory1, "owner-a", {
        allowSameOwnerRefresh: true,
      }),
    ).toEqual({ ok: true });
    expect(getContextEngineRegistration("reg-overwrite")?.factory).toBe(factory1);

    expect(
      registerContextEngineForOwner("reg-overwrite", factory2, "owner-a", {
        allowSameOwnerRefresh: true,
      }),
    ).toEqual({ ok: true });
    expect(getContextEngineRegistration("reg-overwrite")?.factory).toBe(factory2);
    expect(getContextEngineRegistration("reg-overwrite")?.factory).not.toBe(factory1);
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
    expect(getContextEngineRegistration("reg-owner-guard")?.factory).toBe(factory1);
  });

  it("exposes the trusted plugin owner for a resolved registered engine", async () => {
    const engineId = `owner-policy-${Date.now().toString(36)}`;
    registerContextEngineForOwner(engineId, () => new MockContextEngine(), "plugin:lossless-claw", {
      allowSameOwnerRefresh: true,
    });

    const engine = await resolveContextEngine(configWithSlot(engineId));

    expect(resolveContextEngineOwnerPluginId(engine)).toBe("lossless-claw");
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
      ) => ReturnType<typeof registerContextEngine>
    )("public-owner-guard", () => new MockContextEngine(), { owner: "owner-a" });

    expect(spoofAttempt).toEqual({
      ok: false,
      existingOwner: "owner-a",
    });
    expect(getContextEngineRegistration("public-owner-guard")?.factory).toBe(ownedFactory);
  });

  it("public registerContextEngine reserves the default legacy id", () => {
    const legacyAttempt = (
      registerContextEngine as unknown as (
        id: string,
        factory: ContextEngineFactory,
        opts?: { owner?: string },
      ) => ReturnType<typeof registerContextEngine>
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
  beforeEach(() => {
    registerLegacyContextEngine();
    resetContextEngineRuntimeQuarantineForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("keeps learning rejected legacy keys after runtimeSettings marks an engine legacy", async () => {
    const engineId = uniqueEngineId("legacy-runtime-then-assemble");
    const strictEngine = new LegacyRuntimeThenAssembleStrictEngine(engineId);
    registerContextEngine(engineId, () => strictEngine);

    const runtimeSettings = { schemaVersion: 1 } as never;
    const engine = await resolveContextEngine(configWithSlot(engineId));

    await engine.maintain?.({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      sessionFile: "/tmp/session.json",
      runtimeSettings,
    });
    const assembled = await engine.assemble({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      messages: [makeMockMessage("user", "hello")],
      prompt: "hello",
      runtimeSettings,
    });

    expect(assembled.estimatedTokens).toBe(5);
    expect(strictEngine.maintainCalls).toHaveLength(2);
    expect(strictEngine.maintainCalls[0]).toHaveProperty("runtimeSettings");
    expect(strictEngine.maintainCalls[1]).not.toHaveProperty("runtimeSettings");
    expect(strictEngine.assembleCalls).toHaveLength(3);
    expect(strictEngine.assembleCalls[0]).not.toHaveProperty("runtimeSettings");
    expect(strictEngine.assembleCalls[0]).toHaveProperty("sessionKey", "agent:main:test");
    expect(strictEngine.assembleCalls[0]).toHaveProperty("prompt", "hello");
    expect(strictEngine.assembleCalls[1]).not.toHaveProperty("runtimeSettings");
    expect(strictEngine.assembleCalls[1]).not.toHaveProperty("sessionKey");
    expect(strictEngine.assembleCalls[1]).toHaveProperty("prompt", "hello");
    expect(strictEngine.assembleCalls[2]).not.toHaveProperty("runtimeSettings");
    expect(strictEngine.assembleCalls[2]).not.toHaveProperty("sessionKey");
    expect(strictEngine.assembleCalls[2]).not.toHaveProperty("prompt");
  });

  it("quarantines and falls back for non-compat runtime errors", async () => {
    const engineId = `sessionkey-runtime-${Date.now().toString(36)}`;
    const runtimeErrorEngine = new SessionKeyRuntimeErrorEngine(engineId);
    registerContextEngine(engineId, () => runtimeErrorEngine);

    const engine = await resolveContextEngine(configWithSlot(engineId));
    const message = makeMockMessage();

    const result = await engine.assemble({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      messages: [message],
    });
    const nextEngine = await resolveContextEngine(configWithSlot(engineId));

    expect(result.messages).toEqual([message]);
    expect(nextEngine.info.id).toBe("legacy");
    expect(runtimeErrorEngine.assembleCalls).toBe(1);
    expect(listContextEngineQuarantines()).toEqual([
      expect.objectContaining({
        engineId,
        operation: "assemble",
        reason: "sessionKey lookup failed",
      }),
    ]);
  });

  it("quarantines 'Unknown sessionKey' runtime failures instead of treating them as schema compat", async () => {
    const engineId = `sessionkey-unknown-runtime-${Date.now().toString(36)}`;
    const runtimeErrorEngine = new SessionKeyRuntimeErrorEngine(
      engineId,
      'Unknown sessionKey "agent:main:missing"',
    );
    registerContextEngine(engineId, () => runtimeErrorEngine);

    const engine = await resolveContextEngine(configWithSlot(engineId));
    const message = makeMockMessage();

    const result = await engine.assemble({
      sessionId: "s1",
      sessionKey: "agent:main:missing",
      messages: [message],
    });

    expect(result.messages).toEqual([message]);
    expect(runtimeErrorEngine.assembleCalls).toBe(1);
    expect(listContextEngineQuarantines()).toEqual([
      expect.objectContaining({
        engineId,
        operation: "assemble",
        reason: 'Unknown sessionKey "agent:main:missing"',
      }),
    ]);
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
// 3b. Factory context passing
// ═══════════════════════════════════════════════════════════════════════════

describe("Factory context passing", () => {
  it("passes ContextEngineFactoryContext to factories that accept a parameter", async () => {
    const engineId = `factory-ctx-${Date.now().toString(36)}`;
    let receivedCtx: ContextEngineFactoryContext | undefined;

    const factory: ContextEngineFactory = (ctx: ContextEngineFactoryContext) => {
      receivedCtx = ctx;
      return {
        info: { id: engineId, name: "Ctx Engine" },
        async ingest() {
          return { ingested: true };
        },
        async assemble({ messages }: { messages: AgentMessage[] }) {
          return { messages, estimatedTokens: 0 };
        },
        async compact() {
          return { ok: true, compacted: false };
        },
      };
    };
    registerContextEngine(engineId, factory);

    const cfg = configWithSlot(engineId);
    await resolveContextEngine(cfg, {
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });

    const context = requireFactoryContext(receivedCtx);
    expect(context.config).toBe(cfg);
    expect(context.agentDir).toBe("/tmp/agent");
    expect(context.workspaceDir).toBe("/tmp/workspace");
  });

  it("no-arg factories still work when context is passed", async () => {
    const engineId = `factory-noarg-${Date.now().toString(36)}`;
    let called = false;

    const factory: ContextEngineFactory = () => {
      called = true;
      return {
        info: { id: engineId, name: "No-Arg Engine" },
        async ingest() {
          return { ingested: true };
        },
        async assemble({ messages }: { messages: AgentMessage[] }) {
          return { messages, estimatedTokens: 0 };
        },
        async compact() {
          return { ok: true, compacted: false };
        },
      };
    };
    registerContextEngine(engineId, factory);

    const engine = await resolveContextEngine(configWithSlot(engineId), {
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });

    expect(called).toBe(true);
    expect(engine.info.id).toBe(engineId);
  });

  it("passes undefined config when resolveContextEngine is called without config", async () => {
    let receivedCtx: ContextEngineFactoryContext | undefined;

    // Override the default "legacy" engine to intercept the no-config path
    registerContextEngineForOwner(
      "legacy",
      (ctx: ContextEngineFactoryContext) => {
        receivedCtx = ctx;
        return {
          info: { id: "legacy", name: "NoConfig Engine", version: "1" },
          async ingest() {
            return { ingested: true };
          },
          async assemble({ messages }: { messages: AgentMessage[] }) {
            return { messages, estimatedTokens: 0 };
          },
          async compact() {
            return { ok: true, compacted: false };
          },
        };
      },
      "core",
      { allowSameOwnerRefresh: true },
    );

    await resolveContextEngine(undefined);

    const context = requireFactoryContext(receivedCtx);
    expect(context.config).toBeUndefined();
    expect(context.agentDir).toBeUndefined();
    expect(context.workspaceDir).toBeUndefined();
  });
});

describe("Read-only plugin discovery registrations", () => {
  beforeEach(() => {
    registerLegacyContextEngine();
    resetContextEngineRuntimeQuarantineForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not construct or quarantine read-only discovery context-engine factories", async () => {
    const engineId = uniqueEngineId("lossless-readonly");
    const owner = "plugin:lossless-claw";
    let readOnlyFactoryCalls = 0;
    let runtimeFactoryCalls = 0;

    registerContextEngineForOwner(
      engineId,
      () => {
        readOnlyFactoryCalls += 1;
        throw new Error("Engine initialization is disabled during read-only plugin registration");
      },
      owner,
      { allowSameOwnerRefresh: true, lifecycle: "readOnlyDiscovery" },
    );

    const discoveryFallback = await resolveContextEngine(configWithSlot(engineId));

    expect(discoveryFallback.info.id).toBe("legacy");
    expect(readOnlyFactoryCalls).toBe(0);
    expect(listContextEngineQuarantines().some((entry) => entry.engineId === engineId)).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      `[context-engine] Context engine "${engineId}" owner=${owner} is registered for read-only discovery only; falling back to default engine "legacy" without quarantine until runtime activation registers it.`,
    );

    registerContextEngineForOwner(
      engineId,
      () => {
        runtimeFactoryCalls += 1;
        return {
          info: { id: "lossless-claw", name: "Lossless Claw" },
          async ingest() {
            return { ingested: true };
          },
          async assemble({ messages }: { messages: AgentMessage[] }) {
            return { messages, estimatedTokens: 0 };
          },
          async compact() {
            return { ok: true, compacted: false };
          },
        } satisfies ContextEngine;
      },
      owner,
      { allowSameOwnerRefresh: true, lifecycle: "runtime" },
    );

    const runtimeEngine = await resolveContextEngine(configWithSlot(engineId));

    expect(runtimeEngine.info.id).toBe("lossless-claw");
    expect(readOnlyFactoryCalls).toBe(0);
    expect(runtimeFactoryCalls).toBe(1);
    expect(listContextEngineQuarantines().some((entry) => entry.engineId === engineId)).toBe(false);

    registerContextEngineForOwner(
      engineId,
      () => {
        readOnlyFactoryCalls += 1;
        throw new Error("read-only discovery should not replace runtime registration");
      },
      owner,
      { allowSameOwnerRefresh: true, lifecycle: "readOnlyDiscovery" },
    );

    const stillRuntimeEngine = await resolveContextEngine(configWithSlot(engineId));

    expect(stillRuntimeEngine.info.id).toBe("lossless-claw");
    expect(readOnlyFactoryCalls).toBe(0);
    expect(runtimeFactoryCalls).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Invalid engine fallback
// ═══════════════════════════════════════════════════════════════════════════

describe("Invalid engine fallback", () => {
  beforeEach(() => {
    registerLegacyContextEngine();
    resetContextEngineRuntimeQuarantineForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to default engine for missing or invalid requested engines", async () => {
    const cases = [
      {
        name: "missing registration",
        engineId: uniqueEngineId("does-not-exist"),
        register: () => undefined,
        expectedError: (engineId: string) =>
          `[context-engine] Context engine "${engineId}" failed during resolve: not registered; quarantining it for this process and falling back to default engine "legacy".`,
      },
      {
        name: "factory throws",
        engineId: uniqueEngineId("factory-throw"),
        register: (engineId: string) => {
          registerContextEngine(engineId, () => {
            throw new Error("plugin version mismatch");
          });
        },
        expectedError: (engineId: string) =>
          `[context-engine] Context engine "${engineId}" owner=public-sdk failed during factory: plugin version mismatch; quarantining it for this process and falling back to default engine "legacy".`,
      },
      {
        name: "missing info metadata",
        engineId: uniqueEngineId("invalid-info"),
        register: (engineId: string) => {
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
        },
        expectedError: (engineId: string) =>
          `[context-engine] Context engine "${engineId}" owner=public-sdk failed during contract-validation: Context engine "${engineId}" factory returned an invalid ContextEngine: missing info.; quarantining it for this process and falling back to default engine "legacy".`,
      },
      {
        name: "missing lifecycle methods",
        engineId: uniqueEngineId("invalid-methods"),
        register: (engineId: string) => {
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
        },
        expectedError: (engineId: string) =>
          `[context-engine] Context engine "${engineId}" owner=public-sdk failed during contract-validation: Context engine "${engineId}" factory returned an invalid ContextEngine: missing assemble(), missing compact().; quarantining it for this process and falling back to default engine "legacy".`,
      },
      {
        name: "contract validation throws",
        engineId: uniqueEngineId("validation-throw"),
        register: (engineId: string) => {
          registerContextEngine(engineId, () => 42n as unknown as ContextEngine);
        },
        expectedError: (engineId: string) =>
          `[context-engine] Context engine "${engineId}" owner=public-sdk failed during contract-validation: Do not know how to serialize a BigInt; quarantining it for this process and falling back to default engine "legacy".`,
      },
    ] as const;

    for (const testCase of cases) {
      vi.mocked(console.error).mockClear();
      testCase.register(testCase.engineId);

      const engine = await resolveContextEngine(configWithSlot(testCase.engineId));

      expect(engine.info.id, testCase.name).toBe("legacy");
      expect(console.error, testCase.name).toHaveBeenCalledWith(
        testCase.expectedError(testCase.engineId),
      );
      expect(
        listContextEngineQuarantines().some((entry) => entry.engineId === testCase.engineId),
      ).toBe(true);
    }
  });

  it("quarantines a selected engine after lifecycle failure and resolves legacy next time", async () => {
    const engineId = uniqueEngineId("runtime-fail");
    const assemble = vi.fn(async () => {
      throw new Error("lcm db is corrupt");
    });
    let factoryCalls = 0;
    registerContextEngine(engineId, () => {
      factoryCalls += 1;
      return {
        info: { id: "lcm", name: "Lossless Context Manager" },
        async ingest() {
          return { ingested: true };
        },
        assemble,
        async compact() {
          return { ok: true, compacted: false };
        },
      };
    });

    const engine = await resolveContextEngine(configWithSlot(engineId));
    const message = makeMockMessage("user", "hello");
    const result = await engine.assemble({
      sessionId: "s1",
      messages: [message],
    });
    const nextEngine = await resolveContextEngine(configWithSlot(engineId));

    expect(result.messages).toEqual([message]);
    expect(nextEngine.info.id).toBe("legacy");
    expect(factoryCalls).toBe(1);
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(listContextEngineQuarantines()).toEqual([
      expect.objectContaining({
        engineId,
        owner: "public-sdk",
        operation: "assemble",
        reason: "lcm db is corrupt",
      }),
    ]);
    expect(console.error).toHaveBeenCalledWith(
      `[context-engine] Context engine "${engineId}" owner=public-sdk failed during assemble: lcm db is corrupt; quarantining it for this process and falling back to default engine "legacy".`,
    );
  });

  it("exposes fallback metadata on the same engine after lifecycle quarantine", async () => {
    const engineId = uniqueEngineId("runtime-fail-metadata");
    const assemble = vi.fn(async () => {
      throw new Error("plugin store unavailable");
    });
    registerContextEngineForOwner(
      engineId,
      () => ({
        info: {
          id: "lcm",
          name: "Lossless Context Manager",
          ownsCompaction: true,
        },
        async ingest() {
          return { ingested: true };
        },
        assemble,
        async compact() {
          return { ok: true, compacted: false };
        },
      }),
      "plugin:lossless-claw",
      { allowSameOwnerRefresh: true },
    );

    const engine = await resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.ownsCompaction).toBe(true);
    expect(resolveContextEngineOwnerPluginId(engine)).toBe("lossless-claw");

    const message = makeMockMessage("user", "hello");
    const result = await engine.assemble({
      sessionId: "s1",
      messages: [message],
    });

    expect(result.messages).toEqual([message]);
    expect(engine.info.id).toBe("legacy");
    expect(engine.info.ownsCompaction).toBeUndefined();
    expect(resolveContextEngineOwnerPluginId(engine)).toBeUndefined();
    expect(assemble).toHaveBeenCalledTimes(1);
  });

  it("quarantines compact failures without same-call legacy fallback", async () => {
    const engineId = uniqueEngineId("runtime-fail-compact");
    const compact = vi.fn(async () => {
      throw new Error("plugin compaction failed");
    });
    registerContextEngineForOwner(
      engineId,
      () => ({
        info: {
          id: "lcm",
          name: "Lossless Context Manager",
          ownsCompaction: true,
        },
        async ingest() {
          return { ingested: true };
        },
        async assemble({ messages }: { messages: AgentMessage[] }) {
          return { messages, estimatedTokens: 0 };
        },
        compact,
      }),
      "plugin:lossless-claw",
      { allowSameOwnerRefresh: true },
    );

    const engine = await resolveContextEngine(configWithSlot(engineId));

    await expect(
      engine.compact({
        sessionId: "s1",
        sessionKey: "agent:main:s1",
      }),
    ).rejects.toThrow("plugin compaction failed");

    expect(engine.info.id).toBe("legacy");
    expect(engine.info.ownsCompaction).toBeUndefined();
    expect(resolveContextEngineOwnerPluginId(engine)).toBeUndefined();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("clears a missing-engine quarantine when the plugin registers later", async () => {
    const engineId = uniqueEngineId("late-register");
    const missingEngine = await resolveContextEngine(configWithSlot(engineId));

    expect(missingEngine.info.id).toBe("legacy");
    expect(listContextEngineQuarantines()).toEqual([
      expect.objectContaining({
        engineId,
        operation: "resolve",
        reason: "not registered",
      }),
    ]);

    registerContextEngine(engineId, () => ({
      info: { id: engineId, name: "Late Registered Engine" },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }: { messages: AgentMessage[] }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
    }));

    const registeredEngine = await resolveContextEngine(configWithSlot(engineId));

    expect(listContextEngineQuarantines()).toEqual([]);
    expect(registeredEngine.info.id).toBe(engineId);
  });

  it("does not quarantine abort rejections from lifecycle methods", async () => {
    const engineId = uniqueEngineId("abort-rejection");
    const abortError = new Error("compaction aborted");
    abortError.name = "AbortError";
    const controller = new AbortController();
    registerContextEngine(engineId, () => ({
      info: { id: engineId, name: "Abort Aware Engine" },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }: { messages: AgentMessage[] }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        controller.abort(new Error("user stopped run"));
        throw abortError;
      },
    }));

    const engine = await resolveContextEngine(configWithSlot(engineId));

    await expect(
      engine.compact({
        sessionId: "s1",
        sessionKey: "agent:main:s1",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("compaction aborted");

    const nextEngine = await resolveContextEngine(configWithSlot(engineId));
    expect(nextEngine.info.id).toBe(engineId);
    expect(listContextEngineQuarantines()).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("quarantines subagent preparation failures while failing the active spawn closed", async () => {
    const engineId = uniqueEngineId("prepare-subagent-fail");
    registerContextEngine(engineId, () => ({
      info: { id: engineId, name: "Spawn Aware Engine" },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }: { messages: AgentMessage[] }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
      async prepareSubagentSpawn() {
        throw new Error("child context projection failed");
      },
    }));

    const engine = await resolveContextEngine(configWithSlot(engineId));

    await expect(
      engine.prepareSubagentSpawn?.({
        parentSessionKey: "agent:main",
        childSessionKey: "agent:child",
        contextMode: "isolated",
      }),
    ).rejects.toThrow("child context projection failed");

    const nextEngine = await resolveContextEngine(configWithSlot(engineId));
    expect(nextEngine.info.id).toBe("legacy");
    expect(listContextEngineQuarantines()).toEqual([
      expect.objectContaining({
        engineId,
        operation: "prepareSubagentSpawn",
        reason: "child context projection failed",
      }),
    ]);
  });

  it("throws when the default engine itself is not registered", async () => {
    // Access the process-global registry via the well-known symbol and clear it
    // so even the default engine is missing. The symbol key must match the
    // private CONTEXT_ENGINE_REGISTRY_STATE constant in registry.ts — guard
    // against a silent key mismatch so a rename surfaces loudly.
    const registryState = requireRegistryState();
    const snapshot = new Map(registryState.engines);
    registryState.engines.clear();

    try {
      await expect(resolveContextEngine()).rejects.toThrow("not registered");
    } finally {
      for (const [key, value] of snapshot) {
        registryState.engines.set(key, value);
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

  it("accepts resolved engines whose info.id differs from the registered slot id (#66601)", async () => {
    // Regression for openclaw/openclaw#66601: third-party plugins like
    // lossless-claw register under an external slot id ("lossless-claw") but
    // the ContextEngine they return uses the plugin's own internal id
    // (e.g. "lcm"). That id is metadata, not the lookup key.
    const engineId = `plugin-slot-${Date.now().toString(36)}`;
    const internalInfoId = "lcm";
    registerContextEngine(
      engineId,
      () =>
        ({
          info: { id: internalInfoId, name: "Lossless Context Manager", version: "0.5.2" },
          async ingest() {
            return { ingested: true };
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
    // The engine's own info.id is preserved; resolution does not overwrite it.
    expect(engine.info.id).toBe(internalInfoId);
    expect(engine.info.name).toBe("Lossless Context Manager");
    // And the engine is usable through the wrapper.
    const result = await engine.assemble({
      sessionId: "s1",
      messages: [makeMockMessage("user", "hello")],
    });
    expect(result.estimatedTokens).toBe(0);
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
  it("forwards prompt only when callers provide one", async () => {
    const cases = [
      {
        name: "provided",
        params: { prompt: "hello" },
        expectedPrompt: "hello",
      },
      {
        name: "omitted",
        params: {},
        expectedPrompt: null,
      },
      {
        name: "conditional spread undefined",
        params: (() => {
          const callerPrompt: string | undefined = undefined;
          return callerPrompt !== undefined ? { prompt: callerPrompt } : {};
        })(),
        expectedPrompt: null,
      },
    ] as const;

    for (const testCase of cases) {
      const engineId = uniqueEngineId(`prompt-${testCase.name.replace(/\s+/g, "-")}`);
      const calls = registerPromptTrackingEngine(engineId);

      const engine = await resolveContextEngine(configWithSlot(engineId));
      await engine.assemble({
        sessionId: "s1",
        messages: [makeMockMessage("user", "hello")],
        ...testCase.params,
      });

      expect(calls, testCase.name).toHaveLength(1);
      if (testCase.expectedPrompt === null) {
        expect(calls[0], testCase.name).not.toHaveProperty("prompt");
        expect(Object.keys(calls[0] as object), testCase.name).not.toContain("prompt");
      } else {
        expect(calls[0], testCase.name).toHaveProperty("prompt", testCase.expectedPrompt);
      }
    }
  });

  it("retries strict legacy assemble without sessionKey, prompt, and runtimeSettings", async () => {
    const engineId = `prompt-legacy-${Date.now().toString(36)}`;
    const strictEngine = new LegacyAssembleStrictEngine(engineId);
    registerContextEngine(engineId, () => strictEngine);

    const engine = await resolveContextEngine(configWithSlot(engineId));
    const result = await engine.assemble({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      messages: [makeMockMessage("user", "hello")],
      prompt: "hello",
      runtimeSettings: { schemaVersion: 1 } as never,
    });

    expect(result.estimatedTokens).toBe(3);
    expect(strictEngine.assembleCalls).toHaveLength(4);
    expect(strictEngine.assembleCalls[0]).toHaveProperty("sessionKey", "agent:main:test");
    expect(strictEngine.assembleCalls[0]).toHaveProperty("prompt", "hello");
    expect(strictEngine.assembleCalls[0]).toHaveProperty("runtimeSettings");
    expect(strictEngine.assembleCalls[1]).not.toHaveProperty("sessionKey");
    expect(strictEngine.assembleCalls[1]).toHaveProperty("prompt", "hello");
    expect(strictEngine.assembleCalls[1]).toHaveProperty("runtimeSettings");
    expect(strictEngine.assembleCalls[2]).not.toHaveProperty("sessionKey");
    expect(strictEngine.assembleCalls[2]).not.toHaveProperty("prompt");
    expect(strictEngine.assembleCalls[2]).toHaveProperty("runtimeSettings");
    expect(strictEngine.assembleCalls[3]).not.toHaveProperty("sessionKey");
    expect(strictEngine.assembleCalls[3]).not.toHaveProperty("prompt");
    expect(strictEngine.assembleCalls[3]).not.toHaveProperty("runtimeSettings");
  });

  it("retries strict legacy lifecycle hooks without additive host fields", async () => {
    const runtimeSettings = { schemaVersion: 1 } as never;
    const sessionTarget = {
      agentId: "main",
      sessionId: "s1",
      sessionKey: "agent:main:test",
    } satisfies ContextEngineSessionTarget;
    const runtimeContext = { transcriptStorage: { kind: "sqlite" } } as never;
    const resolveStrictEngine = async () => {
      const engineId = uniqueEngineId("runtime-settings-legacy");
      const strictEngine = new LegacyRuntimeSettingsStrictEngine(engineId);
      registerContextEngine(engineId, () => strictEngine);
      const engine = await resolveContextEngine(configWithSlot(engineId));
      return { engine, strictEngine };
    };

    const bootstrap = await resolveStrictEngine();
    await bootstrap.engine.bootstrap?.({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      sessionFile: "sessions/s1.jsonl",
      runtimeSettings,
      sessionTarget,
      runtimeContext,
    });

    const maintain = await resolveStrictEngine();
    await maintain.engine.maintain?.({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      sessionFile: "sessions/s1.jsonl",
      runtimeSettings,
      sessionTarget,
      runtimeContext,
    });

    const afterTurn = await resolveStrictEngine();
    await afterTurn.engine.afterTurn?.({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      sessionFile: "sessions/s1.jsonl",
      messages: [makeMockMessage("assistant", "done")],
      prePromptMessageCount: 0,
      runtimeSettings,
      sessionTarget,
      runtimeContext,
    });

    const assemble = await resolveStrictEngine();
    await assemble.engine.assemble({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      messages: [makeMockMessage("user", "hello")],
      runtimeSettings,
    });

    const compact = await resolveStrictEngine();
    await compact.engine.compact({
      sessionId: "s1",
      sessionKey: "agent:main:test",
      runtimeSettings,
      sessionTarget,
      runtimeContext,
    });

    for (const calls of [
      bootstrap.strictEngine.bootstrapCalls,
      maintain.strictEngine.maintainCalls,
      afterTurn.strictEngine.afterTurnCalls,
      assemble.strictEngine.assembleCalls,
      compact.strictEngine.compactCalls,
    ]) {
      const finalCall = calls.at(-1);
      expect(finalCall).toBeDefined();
      expect(calls[0]).toHaveProperty("runtimeSettings");
      expect(calls[0]).toHaveProperty("sessionKey", "agent:main:test");
      expect(finalCall).toHaveProperty("sessionKey", "agent:main:test");
      expect(finalCall).not.toHaveProperty("runtimeSettings");
      expect(finalCall).not.toHaveProperty("sessionTarget");
      expect(finalCall).not.toHaveProperty("runtimeContext");
    }
    for (const calls of [
      bootstrap.strictEngine.bootstrapCalls,
      maintain.strictEngine.maintainCalls,
      afterTurn.strictEngine.afterTurnCalls,
      compact.strictEngine.compactCalls,
    ]) {
      expect(calls).toHaveLength(4);
      expect(calls[0]).toHaveProperty("sessionTarget", sessionTarget);
      expect(calls[0]).toHaveProperty("runtimeContext", runtimeContext);
    }
    expect(assemble.strictEngine.assembleCalls).toHaveLength(2);
    for (const call of assemble.strictEngine.assembleCalls) {
      expect(call).not.toHaveProperty("sessionTarget");
      expect(call).not.toHaveProperty("runtimeContext");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Initialization guard
// ═══════════════════════════════════════════════════════════════════════════

describe("Initialization guard", () => {
  it("ensureContextEnginesInitialized() is idempotent and registers legacy", async () => {
    const { ensureContextEnginesInitialized } = await import("./init.js");

    expect(ensureContextEnginesInitialized()).toBeUndefined();
    expect(ensureContextEnginesInitialized()).toBeUndefined();

    expect(getContextEngineRegistration("legacy")).toBeDefined();
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
    const dynamicChunk = await import(/* @vite-ignore */ `${registryUrl}?chunk=${ts}-dynamic`);
    const chunks = [
      {
        registerContextEngine,
        getContextEngineRegistration,
        resolveContextEngine,
      },
      dynamicChunk,
    ];

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

    expect(chunks[1].getContextEngineRegistration(engineId)?.factory).toBe(factory);
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

    for (const id of ids) {
      expect(chunks[0].getContextEngineRegistration(id)).toBeDefined();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

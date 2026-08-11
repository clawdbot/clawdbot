// Context engine tests cover context extraction and prompt context assembly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContextEngineLogicalTurnLease,
  selectContextEngineForTranscriptHost,
} from "../agents/harness/context-engine-logical-turn.js";
import { upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptPreparation,
  registerTestMemoryPromptBuilder,
} from "../plugins/memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  requireActivePluginRegistry,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "../plugins/runtime.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../sessions/user-turn-transcript.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
// ---------------------------------------------------------------------------
// We dynamically import the registry so we can get a fresh module per test
// group when needed.  For most groups we use the shared singleton directly.
// ---------------------------------------------------------------------------
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
  prepareMemorySystemPromptAddition,
} from "./delegate.js";
import { LegacyContextEngine } from "./legacy.js";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import {
  activateContextEngineRegistrations,
  getContextEngineRegistration,
  listContextEngineQuarantines,
  registerContextEngineForOwner,
  registerContextEngineInRegistry,
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "./registry.js";
import {
  captureContextEngineRegistryStateForTests,
  resetContextEngineRuntimeQuarantineForTests,
} from "./registry.test-support.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineSessionTarget,
  AssembleResult,
  CompactResult,
  IngestResult,
} from "./types.js";

type ContextEngineFactory = Parameters<typeof registerContextEngineForOwner>[1];
type ContextEngineFactoryContext = Parameters<ContextEngineFactory>[0];

function registerTestContextEngine(id: string, factory: ContextEngineFactory) {
  return registerContextEngineForOwner(id, factory, `test:${id}`, {
    allowSameOwnerRefresh: true,
  });
}

const { compactEmbeddedAgentSessionOnDemandMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionOnDemandMock: vi.fn(),
}));

vi.mock("../agents/embedded-agent-runner/compact.runtime.js", () => ({
  compactEmbeddedAgentSessionOnDemand: compactEmbeddedAgentSessionOnDemandMock,
}));

function installCompactRuntimeSpy() {
  return compactEmbeddedAgentSessionOnDemandMock.mockResolvedValue({
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
  const params = compactEmbeddedAgentSessionOnDemandMock.mock.calls[callIndex]?.[0] as
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

function testAdmissionReceipt(): UserTurnTranscriptAdmissionReceipt {
  return {
    agentId: "main",
    sessionId: "session",
    sessionKey: "agent:main:session",
    storePath: "sqlite://session",
    generation: "generation",
    entryId: "user-entry",
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
    logicalTurnId: "logical-turn",
    role: "user",
  };
}

function makeMockMessage(role: "user" | "assistant" = "user", text = "hello"): AgentMessage {
  return { role, content: text, timestamp: Date.now() } as AgentMessage;
}

let restoreContextEngineRegistry = () => {};

beforeAll(() => {
  restoreContextEngineRegistry = captureContextEngineRegistryStateForTests();
});

afterAll(() => {
  restoreContextEngineRegistry();
});

let uniqueEngineIdCounter = 0;
function uniqueEngineId(prefix: string): string {
  uniqueEngineIdCounter += 1;
  return `${prefix}-${uniqueEngineIdCounter}`;
}

function registerPromptTrackingEngine(engineId: string) {
  const calls: Array<Record<string, unknown>> = [];
  registerTestContextEngine(engineId, () => ({
    info: {
      id: engineId,
      name: "Prompt Tracker",
      version: "0.0.0",
      acceptedHostParams: ["prompt"],
    },
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
  return { engines: requireActivePluginRegistry().contextEngines };
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

// ═══════════════════════════════════════════════════════════════════════════
// 1. Engine contract tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Engine contract tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    compactEmbeddedAgentSessionOnDemandMock.mockReset();
    clearMemoryPluginState();
  });

  it("a mock engine implementing ContextEngine can be registered and resolved", async () => {
    const factory = () => new MockContextEngine();
    registerTestContextEngine("mock", factory);

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
        sessionTarget,
      },
    });
  });

  it("delegateCompactionToRuntime returns successor sessionTarget without sessionFile", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-successor-target-"));
    const storePath = path.join(root, "openclaw-agent.sqlite");
    try {
      compactEmbeddedAgentSessionOnDemandMock.mockResolvedValueOnce({
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
          sessionFile: `sqlite:main:s3-successor:${storePath}`,
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
          storePath,
        },
      });
      expect(result.result).not.toHaveProperty("sessionFile");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows the caller key to rebind to a legacy successor session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-successor-"));
    const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:successor";
    try {
      await upsertSessionEntry(
        { agentId: "main", sessionKey, storePath },
        { sessionId: "before-compaction", updatedAt: 1 },
      );
      await upsertSessionEntry(
        { agentId: "main", sessionKey: "agent:main:aaa-successor-alias", storePath },
        { sessionId: "after-compaction", updatedAt: 2 },
      );
      compactEmbeddedAgentSessionOnDemandMock.mockResolvedValueOnce({
        ok: true,
        compacted: true,
        reason: undefined,
        result: {
          summary: "summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 100,
          tokensAfter: 40,
          details: undefined,
          sessionId: "after-compaction",
          sessionFile: `sqlite:main:after-compaction:${storePath}`,
        },
      });

      const result = await delegateCompactionToRuntime({
        agentId: "main",
        sessionId: "before-compaction",
        sessionKey,
        tokenBudget: 4096,
      });

      expect(result.result?.sessionTarget).toMatchObject({
        agentId: "main",
        sessionId: "after-compaction",
        sessionKey,
        storePath,
      });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a structured successor key from another agent", async () => {
    installCompactRuntimeSpy();

    await expect(
      delegateCompactionToRuntime({
        sessionId: "s-agent-conflict",
        sessionKey: "agent:main:s-agent-conflict",
        sessionTarget: {
          agentId: "worker",
          sessionId: "s-agent-conflict",
          sessionKey: "agent:main:s-agent-conflict",
          storePath: "/tmp/openclaw-agent.sqlite",
        },
        tokenBudget: 4096,
      }),
    ).rejects.toThrow("successor target conflicts with the caller session identity");
  });

  it("rejects a successor marker that changes the caller store", async () => {
    compactEmbeddedAgentSessionOnDemandMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 100,
        sessionId: "store-redirect-successor",
        sessionFile: "sqlite:main:store-redirect-successor:/tmp/other.sqlite",
      },
    });

    await expect(
      delegateCompactionToRuntime({
        sessionId: "store-redirect-source",
        sessionKey: "agent:main:store-redirect",
        sessionTarget: {
          agentId: "main",
          sessionId: "store-redirect-source",
          sessionKey: "agent:main:store-redirect",
          storePath: "/tmp/caller.sqlite",
        },
      }),
    ).rejects.toThrow("successor target conflicts with the caller session identity");
  });

  it("rejects contradictory marker and top-level successor identities", async () => {
    compactEmbeddedAgentSessionOnDemandMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 100,
        sessionId: "top-level-successor",
        sessionFile: "sqlite:main:marker-successor:/tmp/openclaw-agent.sqlite",
      },
    });

    await expect(
      delegateCompactionToRuntime({
        sessionId: "source-session",
        sessionKey: "agent:main:successor-conflict",
      }),
    ).rejects.toThrow("successor identity is inconsistent");
  });

  it("rejects an internally consistent successor for another caller agent", async () => {
    installCompactRuntimeSpy();

    await expect(
      delegateCompactionToRuntime({
        agentId: "main",
        sessionId: "s-agent-redirect",
        sessionKey: "agent:main:s-agent-redirect",
        sessionTarget: {
          agentId: "worker",
          sessionId: "s-agent-redirect",
          sessionKey: "agent:worker:s-agent-redirect",
        },
        tokenBudget: 4096,
      }),
    ).rejects.toThrow("successor target conflicts with the caller session identity");
  });

  it("rejects a legacy successor marker for another caller agent", async () => {
    compactEmbeddedAgentSessionOnDemandMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      reason: undefined,
      result: {
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
        tokensAfter: 40,
        details: undefined,
        sessionId: "worker-successor",
        sessionFile: "sqlite:worker:worker-successor:/tmp/worker-sessions.json",
      },
    });

    await expect(
      delegateCompactionToRuntime({
        agentId: "main",
        sessionId: "main-session",
        sessionKey: "global",
        tokenBudget: 4096,
      }),
    ).rejects.toThrow("successor target conflicts with the caller session identity");
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
    registerTestMemoryPromptBuilder(({ citationsMode }) => [
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
    registerTestMemoryPromptBuilder(({ agentId, agentSessionKey, sandboxed }) => [
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

  it("prepares async memory state before context-engine prompt rendering", async () => {
    const prepare = vi.fn(async () => ["## Prepared Memory", "loaded from sqlite", ""]);
    registerMemoryPromptPreparation("memory-wiki", prepare);

    await expect(
      prepareMemorySystemPromptAddition({
        availableTools: new Set(["wiki_search"]),
        agentId: "main",
        agentSessionKey: "agent:main:main",
      }),
    ).resolves.toBe("## Prepared Memory\nloaded from sqlite");
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Registry tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Registry tests", () => {
  it("registerTestContextEngine() stores retrievable factories", () => {
    const factory = () => new MockContextEngine();
    registerTestContextEngine("reg-test-2", factory);

    expect(getContextEngineRegistration("reg-test-2")?.factory).toBe(factory);
  });

  it("tracks all registered ids", () => {
    registerTestContextEngine("reg-test-a", () => new MockContextEngine());
    registerTestContextEngine("reg-test-b", () => new MockContextEngine());

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

  it("reserves the default engine id even in an empty builder registry", () => {
    const building = createEmptyPluginRegistry();

    expect(
      registerContextEngineInRegistry(
        building,
        "legacy",
        () => new MockContextEngine(),
        "plugin:shadow",
      ),
    ).toEqual({ ok: false, existingOwner: "core" });
    expect(building.contextEngines.size).toBe(0);
  });

  it("exposes the trusted plugin owner for a resolved registered engine", async () => {
    const engineId = `owner-policy-${Date.now().toString(36)}`;
    registerContextEngineForOwner(engineId, () => new MockContextEngine(), "plugin:lossless-claw", {
      allowSameOwnerRefresh: true,
    });

    const engine = await resolveContextEngine(configWithSlot(engineId));

    expect(resolveContextEngineOwnerPluginId(engine)).toBe("lossless-claw");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Default engine selection
// ═══════════════════════════════════════════════════════════════════════════

describe("Default engine selection", () => {
  // Ensure both legacy and a custom test engine are registered before these tests.
  beforeEach(() => {
    // Registration is idempotent (Map.set), so calling again is safe.
    registerLegacyContextEngine();
    // Register a lightweight custom stub so we don't need external resources.
    registerTestContextEngine("test-engine", () => {
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

  it.each([
    {
      label: "implicit legacy without an admission receipt",
      config: undefined,
      admission: undefined,
    },
    {
      label: "explicit legacy without an admission receipt",
      config: configWithSlot("legacy"),
      admission: undefined,
    },
    {
      label: "implicit legacy without declared transcript fencing",
      config: undefined,
      admission: testAdmissionReceipt(),
    },
  ])("keeps $label configured without a warning", async ({ config, admission }) => {
    const warn = vi.fn();
    const lease = await createContextEngineLogicalTurnLease({ config, warn });

    const selected = selectContextEngineForTranscriptHost({
      lease,
      host: { id: "agent-harness:test", label: "test harness", capabilities: [] },
      operation: "agent-run",
      recorder: { getAdmissionReceipt: () => admission, hasPersisted: () => true },
    });

    expect(selected).toMatchObject({ registeredId: "legacy", mode: "configured" });
    expect(lease.effectiveEngineId).toBe("legacy");
    expect(lease.degraded).toBe(false);
    expect(lease.degradedReason).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    await lease.dispose();
  });

  it("keeps repeated baseline host selection stable after the turn starts", async () => {
    const warn = vi.fn();
    const lease = await createContextEngineLogicalTurnLease({ warn });
    const selection = {
      host: { id: "agent-harness:test", label: "test harness", capabilities: [] },
      operation: "agent-run" as const,
      requiresDurableCommit: true,
    };

    const first = lease.selectForHost(selection);
    lease.begin();
    const second = lease.selectForHost(selection);

    expect(second).toMatchObject({ registeredId: "legacy", mode: "configured" });
    expect(second.engine).toBe(first.engine);
    expect(lease.degraded).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    await lease.dispose();
  });

  it("keeps repeated baseline transcript-host selection stable after the turn starts", async () => {
    const warn = vi.fn();
    const lease = await createContextEngineLogicalTurnLease({ warn });
    const selection = {
      lease,
      host: { id: "agent-harness:test", label: "test harness", capabilities: [] },
      operation: "agent-run" as const,
      recorder: { getAdmissionReceipt: () => undefined, hasPersisted: () => true },
    };

    const first = selectContextEngineForTranscriptHost(selection);
    lease.begin();
    const second = selectContextEngineForTranscriptHost(selection);

    expect(second).toMatchObject({ registeredId: "legacy", mode: "configured" });
    expect(second.engine).toBe(first.engine);
    expect(lease.degraded).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    await lease.dispose();
  });

  it("rejects baseline transcript-host selection after disposal", async () => {
    const lease = await createContextEngineLogicalTurnLease({});
    await lease.dispose();

    expect(() =>
      selectContextEngineForTranscriptHost({
        lease,
        host: { id: "agent-harness:test", label: "test harness", capabilities: [] },
        operation: "agent-run",
        recorder: { getAdmissionReceipt: () => undefined, hasPersisted: () => true },
      }),
    ).toThrow("context-engine logical turn selection is already pinned");
  });

  it("still rejects an attempted custom-engine transition after the turn starts", async () => {
    const engineId = uniqueEngineId("logical-turn-late-transition");
    registerTestContextEngine(engineId, () => ({
      info: {
        id: engineId,
        name: "Late Transition",
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
      async commitTurn() {
        return { status: "committed" };
      },
    }));
    const lease = await createContextEngineLogicalTurnLease({
      config: configWithSlot(engineId),
    });
    lease.begin();

    expect(() => lease.degradeBeforeStart("late transition")).toThrow(
      "context-engine logical turn selection is already pinned",
    );
    await lease.dispose();
  });

  it("degrades and warns when an invalid configured id resolves to legacy", async () => {
    const engineId = uniqueEngineId("logical-turn-invalid");
    const warn = vi.fn();

    const lease = await createContextEngineLogicalTurnLease({
      config: configWithSlot(engineId),
      warn,
    });

    expect(lease.effectiveEngineId).toBe("legacy");
    expect(lease.degraded).toBe(true);
    expect(lease.degradedReason).toBe(`context engine "${engineId}" is not registered`);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Context engine "${engineId}" degraded to "legacy"`),
    );
    await lease.dispose();
  });

  it("degrades and warns when configured engine discovery is read-only", async () => {
    const engineId = uniqueEngineId("logical-turn-discovery");
    registerContextEngineForOwner(engineId, () => new MockContextEngine(), `test:${engineId}`, {
      lifecycle: "readOnlyDiscovery",
    });
    const warn = vi.fn();

    const lease = await createContextEngineLogicalTurnLease({
      config: configWithSlot(engineId),
      warn,
    });

    expect(lease.effectiveEngineId).toBe("legacy");
    expect(lease.degradedReason).toBe(
      `context engine "${engineId}" is available for discovery only`,
    );
    expect(warn).toHaveBeenCalledOnce();
    await lease.dispose();
  });

  it("degrades and warns when the configured engine factory fails", async () => {
    const engineId = uniqueEngineId("logical-turn-factory");
    registerTestContextEngine(engineId, () => {
      throw new Error("factory unavailable");
    });
    const warn = vi.fn();

    const lease = await createContextEngineLogicalTurnLease({
      config: configWithSlot(engineId),
      warn,
    });

    expect(lease.effectiveEngineId).toBe("legacy");
    expect(lease.degradedReason).toBe("factory unavailable");
    expect(warn).toHaveBeenCalledOnce();
    await lease.dispose();
  });

  it("uses registered identity when custom engine metadata is also legacy", async () => {
    const engineId = uniqueEngineId("logical-turn-legacy-alias");
    registerTestContextEngine(engineId, () => ({
      info: { id: "legacy", name: "Legacy Alias" },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
    }));
    const warn = vi.fn();
    const lease = await createContextEngineLogicalTurnLease({
      config: configWithSlot(engineId),
      warn,
    });

    const selected = selectContextEngineForTranscriptHost({
      lease,
      host: { id: "agent-harness:test", label: "test harness", capabilities: [] },
      operation: "agent-run",
      recorder: { getAdmissionReceipt: testAdmissionReceipt, hasPersisted: () => true },
    });

    expect(selected).toMatchObject({ registeredId: "legacy", mode: "legacy-degraded" });
    expect(lease.degradedReason).toBe("current-turn transcript fencing is not declared");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Context engine "${engineId}" degraded to "legacy"`),
    );
    await lease.dispose();
  });

  it("does not replay a started engine operation and retries the configured engine next turn", async () => {
    const engineId = uniqueEngineId("logical-turn-retry");
    const assemble = vi
      .fn<ContextEngine["assemble"]>()
      .mockRejectedValueOnce(new Error("configured engine unavailable"))
      .mockImplementation(async ({ messages }) => ({ messages, estimatedTokens: 0 }));
    registerTestContextEngine(engineId, () => ({
      info: { id: engineId, name: "Logical Turn Retry" },
      async ingest() {
        return { ingested: true };
      },
      assemble,
      async compact() {
        return { ok: true, compacted: false };
      },
    }));
    const warn = vi.fn();
    const first = await createContextEngineLogicalTurnLease({
      config: configWithSlot(engineId),
      warn,
    });
    const messages = [makeMockMessage()];

    first.begin();
    await expect(first.engine.assemble({ sessionId: "first", messages })).rejects.toThrow(
      "configured engine unavailable",
    );
    expect(first.degraded).toBe(false);
    expect(first.engine.info.id).toBe(engineId);
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    await first.dispose();

    const second = await createContextEngineLogicalTurnLease({
      config: configWithSlot(engineId),
      warn,
    });
    await expect(second.engine.assemble({ sessionId: "second", messages })).resolves.toMatchObject({
      messages,
    });
    expect(second.degraded).toBe(false);
    expect(second.engine.info.id).toBe(engineId);
    expect(assemble).toHaveBeenCalledTimes(2);
    await second.dispose();
  });

  it("rejects an incompatible fallback host after the logical turn starts", async () => {
    const engineId = uniqueEngineId("logical-turn-host-transition");
    registerTestContextEngine(engineId, () => ({
      info: {
        id: engineId,
        name: "Host Transition",
        hostRequirements: {
          "agent-run": { requiredCapabilities: ["thread-bootstrap-projection"] },
        },
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
      async commitTurn() {
        return { status: "committed" };
      },
    }));
    const lease = await createContextEngineLogicalTurnLease({
      config: configWithSlot(engineId),
    });

    lease.selectForHost({
      host: {
        id: "agent-harness:first",
        label: 'agent harness "first"',
        capabilities: ["thread-bootstrap-projection"],
      },
      operation: "agent-run",
      requiresDurableCommit: true,
    });
    lease.begin();

    expect(() =>
      lease.selectForHost({
        host: {
          id: "agent-harness:fallback",
          label: 'agent harness "fallback"',
          capabilities: [],
        },
        operation: "agent-run",
        requiresDurableCommit: true,
      }),
    ).toThrow(
      'context-engine logical turn cannot change to incompatible agent harness "fallback": host "agent-harness:fallback" is missing thread-bootstrap-projection',
    );
    expect(lease.engine.info.id).toBe(engineId);
    await lease.dispose();
  });

  it.each([
    {
      label: "persisted without a receipt",
      persisted: true,
      declaresFence: true,
      expectedEngine: "legacy",
      expectedReason: "current-turn transcript admission receipt is unavailable",
    },
    {
      label: "not yet persisted",
      persisted: false,
      declaresFence: true,
      expectedEngine: "configured",
      expectedReason: undefined,
    },
    {
      label: "not yet persisted without declared fencing",
      persisted: false,
      declaresFence: false,
      expectedEngine: "legacy",
      expectedReason: "current-turn transcript fencing is not declared",
    },
  ])("selects $expectedEngine for a turn $label", async (testCase) => {
    const engineId = uniqueEngineId("logical-turn-recorder-state");
    registerTestContextEngine(engineId, () => ({
      info: {
        id: engineId,
        name: "Recorder State",
        transcriptSemantics: {
          ...(testCase.declaresFence
            ? { currentTurnFence: "before-current-turn-entry-v1" as const }
            : {}),
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
      async commitTurn() {
        return { status: "committed" };
      },
    }));
    const warn = vi.fn();
    const lease = await createContextEngineLogicalTurnLease({
      config: configWithSlot(engineId),
      warn,
    });

    const selected = selectContextEngineForTranscriptHost({
      lease,
      host: { id: "agent-harness:test", label: "test harness", capabilities: [] },
      operation: "agent-run",
      recorder: {
        getAdmissionReceipt: () => undefined,
        hasPersisted: () => testCase.persisted,
      },
    });
    lease.begin();

    expect(selected.engine.info.id).toBe(
      testCase.expectedEngine === "configured" ? engineId : "legacy",
    );
    expect(lease.degradedReason).toBe(testCase.expectedReason);
    if (testCase.expectedReason) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(testCase.expectedReason));
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
    await lease.dispose();
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
    registerTestContextEngine(engineId, factory);

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
    registerTestContextEngine(engineId, factory);

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
          registerTestContextEngine(engineId, () => {
            throw new Error("plugin version mismatch");
          });
        },
        expectedError: (engineId: string) =>
          `[context-engine] Context engine "${engineId}" owner=test:${engineId} failed during factory: plugin version mismatch; quarantining it for this process and falling back to default engine "legacy".`,
      },
      {
        name: "missing info metadata",
        engineId: uniqueEngineId("invalid-info"),
        register: (engineId: string) => {
          registerTestContextEngine(
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
          `[context-engine] Context engine "${engineId}" owner=test:${engineId} failed during contract-validation: Context engine "${engineId}" factory returned an invalid ContextEngine: missing info.; quarantining it for this process and falling back to default engine "legacy".`,
      },
      {
        name: "missing lifecycle methods",
        engineId: uniqueEngineId("invalid-methods"),
        register: (engineId: string) => {
          registerTestContextEngine(
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
          `[context-engine] Context engine "${engineId}" owner=test:${engineId} failed during contract-validation: Context engine "${engineId}" factory returned an invalid ContextEngine: missing assemble(), missing compact().; quarantining it for this process and falling back to default engine "legacy".`,
      },
      {
        name: "contract validation throws",
        engineId: uniqueEngineId("validation-throw"),
        register: (engineId: string) => {
          registerTestContextEngine(engineId, () => 42n as unknown as ContextEngine);
        },
        expectedError: (engineId: string) =>
          `[context-engine] Context engine "${engineId}" owner=test:${engineId} failed during contract-validation: Do not know how to serialize a BigInt; quarantining it for this process and falling back to default engine "legacy".`,
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
    registerTestContextEngine(engineId, () => {
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
        owner: `test:${engineId}`,
        operation: "assemble",
        reason: "lcm db is corrupt",
      }),
    ]);
    expect(console.error).toHaveBeenCalledWith(
      `[context-engine] Context engine "${engineId}" owner=test:${engineId} failed during assemble: lcm db is corrupt; quarantining it for this process and falling back to default engine "legacy".`,
    );
  });

  it("coalesces fallback initialization across concurrent lifecycle failures", async () => {
    const defaultFactory = vi.fn(async () => new LegacyContextEngine());
    registerContextEngineForOwner("legacy", defaultFactory, "core", {
      allowSameOwnerRefresh: true,
    });
    const engineId = uniqueEngineId("concurrent-runtime-fail");
    const assemble = vi.fn(async () => {
      await Promise.resolve();
      throw new Error("plugin context unavailable");
    });
    registerTestContextEngine(engineId, () => ({
      info: { id: engineId, name: "Concurrent Context Engine" },
      async ingest() {
        return { ingested: true };
      },
      assemble,
      async compact() {
        return { ok: true, compacted: false };
      },
    }));
    const engine = await resolveContextEngine(configWithSlot(engineId));
    const messages = [makeMockMessage("user", "first"), makeMockMessage("user", "second")];

    const results = await Promise.all(
      messages.map((message, index) =>
        engine.assemble({ sessionId: `session-${index}`, messages: [message] }),
      ),
    );

    expect(results.map(({ messages: assembled }) => assembled)).toEqual(
      messages.map((message) => [message]),
    );
    expect(assemble).toHaveBeenCalledTimes(2);
    expect(defaultFactory).toHaveBeenCalledTimes(1);
    expect(listContextEngineQuarantines()).toEqual([
      expect.objectContaining({ engineId, operation: "assemble" }),
    ]);
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

  it("routes legacy resolver fence failures through normal quarantine", async () => {
    const engineId = uniqueEngineId("transcript-fence-fallback");
    const ingest = vi.fn(async () => ({ ingested: true }));
    const assemble = vi.fn(async () => {
      throw new SessionTranscriptReadFenceError("admitted user row is unavailable");
    });
    registerContextEngineForOwner(
      engineId,
      () => ({
        info: {
          id: "lcm",
          name: "Lossless Context Manager",
          ownsCompaction: true,
        },
        ingest,
        assemble,
        async compact() {
          return { ok: true, compacted: false };
        },
      }),
      "plugin:lossless-claw",
      { allowSameOwnerRefresh: true },
    );

    const engine = await resolveContextEngine(configWithSlot(engineId));
    expect(resolveContextEngineOwnerPluginId(engine)).toBe("lossless-claw");

    const first = makeMockMessage("user", "first");
    const second = makeMockMessage("user", "second");
    await expect(engine.assemble({ sessionId: "s1", messages: [first] })).resolves.toMatchObject({
      messages: [first],
    });
    await expect(engine.assemble({ sessionId: "s1", messages: [second] })).resolves.toMatchObject({
      messages: [second],
    });
    await engine.ingest({ sessionId: "s1", message: second });

    expect(engine.info.id).toBe("legacy");
    expect(resolveContextEngineOwnerPluginId(engine)).toBeUndefined();
    expect(listContextEngineQuarantines()).toEqual([
      expect.objectContaining({
        engineId,
        operation: "assemble",
        reason: "admitted user row is unavailable",
      }),
    ]);
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
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

    registerTestContextEngine(engineId, () => ({
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

  it("defers quarantine clearing for builder-context direct registrations", async () => {
    const engineId = uniqueEngineId("builder-register");
    await resolveContextEngine(configWithSlot(engineId));
    const builder = createEmptyPluginRegistry();

    withPluginRegistrationContext(builder, "context-builder", () => {
      registerContextEngineForOwner(
        engineId,
        () => new MockContextEngine(),
        "plugin:context-builder",
        { allowSameOwnerRefresh: true },
      );
    });

    expect(builder.contextEngines.has(engineId)).toBe(true);
    expect(getContextEngineRegistration(engineId)).toBeUndefined();
    expect(listContextEngineQuarantines()).toEqual([
      expect.objectContaining({ engineId, reason: "not registered" }),
    ]);

    setActivePluginRegistry(builder);
    activateContextEngineRegistrations(builder);
    expect(listContextEngineQuarantines()).toEqual([]);
  });

  it("does not quarantine abort rejections from lifecycle methods", async () => {
    const engineId = uniqueEngineId("abort-rejection");
    const abortError = new Error("compaction aborted");
    abortError.name = "AbortError";
    const controller = new AbortController();
    registerTestContextEngine(engineId, () => ({
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
    registerTestContextEngine(engineId, () => ({
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
    registerTestContextEngine(
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
// registering an owned engine from chunk A is visible to
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
        registerContextEngineForOwner,
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
    chunks[0].registerContextEngineForOwner(engineId, factory, `test:${engineId}`);

    expect(chunks[1].getContextEngineRegistration(engineId)?.factory).toBe(factory);
    const engine = await chunks[1].resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe(engineId);

    const ids = chunks.map((_, i) => `concurrent-${ts}-${i}`);
    const registrationTasks = chunks.map((chunk, i) =>
      Promise.resolve().then(() => {
        const id = `concurrent-${ts}-${i}`;
        chunk.registerContextEngineForOwner(id, () => new MockContextEngine(), `test:${id}`);
      }),
    );
    await Promise.all(registrationTasks);

    for (const id of ids) {
      expect(chunks[0].getContextEngineRegistration(id)).toBeDefined();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

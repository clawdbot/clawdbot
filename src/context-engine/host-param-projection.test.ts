import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../agents/runtime/index.js";
import { isRuntimeCompactionDelegate } from "./delegate.js";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import {
  listContextEngineQuarantines,
  registerContextEngineForOwner,
  resolveContextEngine,
  resolveLogicalTurnContextEngines,
} from "./registry.js";
import {
  captureContextEngineRegistryStateForTests,
  resetContextEngineRuntimeQuarantineForTests,
} from "./registry.test-support.js";
import type { ContextEngine, ContextEngineInfo, ContextEngineRuntimeSettings } from "./types.js";

const message = { role: "user", content: "hello", timestamp: 1 } as AgentMessage;
const runtimeSettings = {} as ContextEngineRuntimeSettings;
let engineCounter = 0;

function registerProbeEngine(params: {
  acceptedHostParams?: string[];
  assembleCalls: Array<Record<string, unknown>>;
  compactCalls: Array<Record<string, unknown>>;
  commitTurnCalls?: Array<Record<string, unknown>>;
  maintainCalls?: Array<Record<string, unknown>>;
  rejectAssemble?: boolean;
}): string {
  const engineId = `host-param-probe-${++engineCounter}`;
  registerContextEngineForOwner(
    engineId,
    () =>
      ({
        info: {
          id: engineId,
          name: "Host Param Probe",
          ...(params.acceptedHostParams ? { acceptedHostParams: params.acceptedHostParams } : {}),
        } satisfies ContextEngineInfo,
        async ingest() {
          return { ingested: true };
        },
        async assemble(callParams) {
          params.assembleCalls.push({ ...callParams });
          if (params.rejectAssemble) {
            throw new Error("Unrecognized key(s) in object: 'runtimeSettings'");
          }
          return { messages: callParams.messages, estimatedTokens: 0 };
        },
        async compact(callParams) {
          params.compactCalls.push({ ...callParams });
          return { ok: true, compacted: false };
        },
        async maintain(callParams) {
          params.maintainCalls?.push({ ...callParams });
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
        },
        async commitTurn(callParams) {
          params.commitTurnCalls?.push({ ...callParams });
          return { status: "committed" };
        },
      }) satisfies ContextEngine,
    `test:${engineId}`,
  );
  return engineId;
}

async function invokeHostParamMethods(engine: ContextEngine) {
  const abortSignal = new AbortController().signal;
  await engine.assemble({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    messages: [message],
    prompt: "hello",
    runtimeSettings,
  });
  await engine.compact({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionTarget: { agentId: "main", sessionId: "session-1" },
    runtimeSettings,
    runtimeContext: { tokenBudget: 1000 },
    abortSignal,
  });
  await engine.maintain?.({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: "/tmp/session-1.jsonl",
    runtimeSettings,
    runtimeContext: { tokenBudget: 1000 },
    abortSignal,
  });
  return abortSignal;
}

describe("context-engine host parameter projection", () => {
  let restoreRegistry = () => {};

  beforeAll(() => {
    restoreRegistry = captureContextEngineRegistryStateForTests();
  });

  beforeEach(() => {
    registerLegacyContextEngine();
    resetContextEngineRuntimeQuarantineForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    restoreRegistry();
  });

  it("passes declared current host parameters", async () => {
    const assembleCalls: Array<Record<string, unknown>> = [];
    const compactCalls: Array<Record<string, unknown>> = [];
    const maintainCalls: Array<Record<string, unknown>> = [];
    const engineId = registerProbeEngine({
      acceptedHostParams: [
        "sessionKey",
        "prompt",
        "runtimeSettings",
        "sessionTarget",
        "runtimeContext",
        "abortSignal",
      ],
      assembleCalls,
      compactCalls,
      maintainCalls,
    });

    const abortSignal = await invokeHostParamMethods(
      await resolveContextEngine({ plugins: { slots: { contextEngine: engineId } } }),
    );

    expect(assembleCalls[0]).toMatchObject({
      sessionKey: "agent:main:session-1",
      prompt: "hello",
      runtimeSettings,
    });
    expect(compactCalls[0]).toMatchObject({
      sessionKey: "agent:main:session-1",
      sessionTarget: { agentId: "main", sessionId: "session-1" },
      runtimeSettings,
      runtimeContext: { tokenBudget: 1000 },
      abortSignal,
    });
    expect(maintainCalls[0]).toMatchObject({
      sessionKey: "agent:main:session-1",
      runtimeSettings,
      runtimeContext: { tokenBudget: 1000 },
      abortSignal,
    });
  });

  it("preserves native compaction watchdog ownership in logical-turn resolution", async () => {
    const resolution = await resolveLogicalTurnContextEngines();

    // oxlint-disable-next-line typescript/unbound-method -- the identity predicate never invokes compact.
    expect(isRuntimeCompactionDelegate(resolution.fallback.engine.compact)).toBe(true);
  });

  it("projects host parameters on fresh logical-turn engines", async () => {
    const assembleCalls: Array<Record<string, unknown>> = [];
    const compactCalls: Array<Record<string, unknown>> = [];
    const maintainCalls: Array<Record<string, unknown>> = [];
    const engineId = registerProbeEngine({
      acceptedHostParams: ["runtimeSettings"],
      assembleCalls,
      compactCalls,
      maintainCalls,
    });
    const resolution = await resolveLogicalTurnContextEngines({
      plugins: { slots: { contextEngine: engineId } },
    });

    const abortSignal = await invokeHostParamMethods(resolution.configured.engine);

    expect(assembleCalls[0]).toMatchObject({ sessionId: "session-1", runtimeSettings });
    expect(assembleCalls[0]).not.toHaveProperty("sessionKey");
    expect(assembleCalls[0]).not.toHaveProperty("prompt");
    expect(compactCalls[0]).toMatchObject({ sessionId: "session-1", runtimeSettings, abortSignal });
    expect(compactCalls[0]).not.toHaveProperty("sessionTarget");
    expect(compactCalls[0]).not.toHaveProperty("runtimeContext");
    expect(maintainCalls[0]).toMatchObject({ sessionId: "session-1", runtimeSettings });
    expect(maintainCalls[0]).not.toHaveProperty("sessionKey");
    expect(maintainCalls[0]).not.toHaveProperty("runtimeContext");
    expect(maintainCalls[0]).not.toHaveProperty("abortSignal");
    await Promise.allSettled([
      resolution.configured.engine.dispose?.(),
      resolution.fallback.engine.dispose?.(),
    ]);
  });

  it("projects declared host parameters for commitTurn", async () => {
    const commitTurnCalls: Array<Record<string, unknown>> = [];
    const engineId = registerProbeEngine({
      acceptedHostParams: ["runtimeSettings"],
      assembleCalls: [],
      compactCalls: [],
      commitTurnCalls,
    });
    const resolution = await resolveLogicalTurnContextEngines({
      plugins: { slots: { contextEngine: engineId } },
    });
    const admission = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: "/tmp/openclaw-agent.sqlite",
      generation: "generation-1",
      entryId: "user-1",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 0,
      logicalTurnId: "turn-1",
      role: "user" as const,
    };

    await resolution.configured.engine.commitTurn?.({
      advancementKey: "turn-1",
      admission,
      terminal: {
        ...admission,
        entryId: "assistant-1",
        rawSeq: 2,
        effectiveParentId: "user-1",
        activeMessagePosition: 1,
      },
      messages: [message],
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionTarget: { agentId: "main", sessionId: "session-1" },
      runtimeSettings,
      runtimeContext: { tokenBudget: 1000 },
    });

    expect(commitTurnCalls).toEqual([
      expect.objectContaining({
        advancementKey: "turn-1",
        sessionId: "session-1",
        runtimeSettings,
      }),
    ]);
    expect(commitTurnCalls[0]).not.toHaveProperty("sessionKey");
    expect(commitTurnCalls[0]).not.toHaveProperty("sessionTarget");
    expect(commitTurnCalls[0]).not.toHaveProperty("runtimeContext");
    await Promise.allSettled([
      resolution.configured.engine.dispose?.(),
      resolution.fallback.engine.dispose?.(),
    ]);
  });

  it("passes every host parameter to fresh undeclared engines", async () => {
    const assembleCalls: Array<Record<string, unknown>> = [];
    const compactCalls: Array<Record<string, unknown>> = [];
    const maintainCalls: Array<Record<string, unknown>> = [];
    const engineId = registerProbeEngine({ assembleCalls, compactCalls, maintainCalls });
    const resolution = await resolveLogicalTurnContextEngines({
      plugins: { slots: { contextEngine: engineId } },
    });

    const abortSignal = await invokeHostParamMethods(resolution.configured.engine);

    expect(assembleCalls[0]).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      prompt: "hello",
      runtimeSettings,
    });
    expect(compactCalls[0]).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionTarget: { agentId: "main", sessionId: "session-1" },
      runtimeSettings,
      runtimeContext: { tokenBudget: 1000 },
      abortSignal,
    });
    expect(maintainCalls[0]).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runtimeSettings,
      runtimeContext: { tokenBudget: 1000 },
      abortSignal,
    });
    await Promise.allSettled([
      resolution.configured.engine.dispose?.(),
      resolution.fallback.engine.dispose?.(),
    ]);
  });

  it("passes every host parameter to resolved undeclared engines", async () => {
    const assembleCalls: Array<Record<string, unknown>> = [];
    const compactCalls: Array<Record<string, unknown>> = [];
    const maintainCalls: Array<Record<string, unknown>> = [];
    const engineId = registerProbeEngine({ assembleCalls, compactCalls, maintainCalls });
    const engine = await resolveContextEngine({ plugins: { slots: { contextEngine: engineId } } });

    const abortSignal = await invokeHostParamMethods(engine);

    expect(assembleCalls[0]).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      prompt: "hello",
      runtimeSettings,
    });
    expect(compactCalls[0]).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionTarget: { agentId: "main", sessionId: "session-1" },
      runtimeSettings,
      runtimeContext: { tokenBudget: 1000 },
      abortSignal,
    });
    expect(maintainCalls[0]).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runtimeSettings,
      runtimeContext: { tokenBudget: 1000 },
      abortSignal,
    });
  });

  it("does not retry validator-shaped engine failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const assembleCalls: Array<Record<string, unknown>> = [];
    const engineId = registerProbeEngine({
      acceptedHostParams: ["runtimeSettings"],
      assembleCalls,
      compactCalls: [],
      rejectAssemble: true,
    });
    const engine = await resolveContextEngine({
      plugins: { slots: { contextEngine: engineId } },
    });

    await engine.assemble({
      sessionId: "session-1",
      messages: [message],
      runtimeSettings,
    });

    expect(assembleCalls).toHaveLength(1);
    expect(listContextEngineQuarantines()).toEqual([
      expect.objectContaining({ engineId, operation: "assemble" }),
    ]);
  });

  it.each(["process", "logical-turn"] as const)(
    "does not mutate frozen engines reused by a factory (%s)",
    async (mode) => {
      const engineId = `host-param-frozen-${++engineCounter}`;
      const assemble = vi.fn<ContextEngine["assemble"]>(async (params) => ({
        messages: params.messages,
        estimatedTokens: 0,
      }));
      class FrozenProbeEngine implements ContextEngine {
        readonly #info = { id: engineId, name: "Frozen Probe", acceptedHostParams: [] };

        get info() {
          return this.#info;
        }

        async ingest() {
          return { ingested: true };
        }

        assemble = assemble;

        async compact() {
          return { ok: true, compacted: false };
        }
      }
      const sharedEngine = Object.freeze(new FrozenProbeEngine());
      registerContextEngineForOwner(engineId, () => sharedEngine, `test:${engineId}`);

      const config = { plugins: { slots: { contextEngine: engineId } } };
      const firstTurn =
        mode === "logical-turn" ? await resolveLogicalTurnContextEngines(config) : undefined;
      const secondTurn =
        mode === "logical-turn" ? await resolveLogicalTurnContextEngines(config) : undefined;
      const first = firstTurn?.configured.engine ?? (await resolveContextEngine(config));
      const second = secondTurn?.configured.engine ?? (await resolveContextEngine(config));
      try {
        expect(first.info).toEqual({ id: engineId, name: "Frozen Probe", acceptedHostParams: [] });
        await first.assemble({ sessionId: "session-1", sessionKey: "first", messages: [message] });
        await second.assemble({
          sessionId: "session-2",
          sessionKey: "second",
          messages: [message],
        });

        expect(assemble).toHaveBeenCalledTimes(2);
        expect(assemble.mock.contexts[0]).toBe(sharedEngine);
        expect(assemble.mock.contexts[1]).toBe(sharedEngine);
        expect(assemble.mock.calls.map(([params]) => params)).toEqual([
          { sessionId: "session-1", messages: [message] },
          { sessionId: "session-2", messages: [message] },
        ]);
      } finally {
        await Promise.allSettled([
          firstTurn?.fallback.engine.dispose?.(),
          secondTurn?.fallback.engine.dispose?.(),
        ]);
      }
    },
  );

  it("preserves raw call identity despite process quarantine", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const engineId = `host-param-quarantined-${++engineCounter}`;
    const processFailure = new Error("process compact failed");
    const syncFailure = new Error("raw assemble failed");
    const retainedPromise = Promise.resolve({ messages: [message], estimatedTokens: 0 });
    const assemble = vi
      .fn<ContextEngine["assemble"]>()
      .mockReturnValueOnce(retainedPromise)
      .mockImplementationOnce(() => {
        throw syncFailure;
      });
    const info = { id: engineId, name: "Quarantined Probe", acceptedHostParams: [] };
    registerContextEngineForOwner(
      engineId,
      () => ({
        info,
        ingest: async () => ({ ingested: true }),
        assemble,
        compact: async () => {
          throw processFailure;
        },
      }),
      `plugin:${engineId}`,
    );
    const config = { plugins: { slots: { contextEngine: engineId } } };
    const processEngine = await resolveContextEngine(config);
    await expect(
      processEngine.compact({ sessionId: "session-1", sessionKey: "agent:main:session-1" }),
    ).rejects.toBe(processFailure);
    const quarantine = listContextEngineQuarantines();
    expect(quarantine).toEqual([expect.objectContaining({ engineId, operation: "compact" })]);

    const resolution = await resolveLogicalTurnContextEngines(config);
    try {
      expect(resolution.configured.ownerPluginId).toBe(engineId);
      expect(resolution.configured.engine.info).toBe(info);
      const params = { sessionId: "session-1", sessionKey: "raw", messages: [message] };
      const result = resolution.configured.engine.assemble(params);
      expect(result).toBe(retainedPromise);
      await expect(result).resolves.toEqual({ messages: [message], estimatedTokens: 0 });

      let returned: ReturnType<ContextEngine["assemble"]> | undefined;
      let thrown: unknown;
      try {
        returned = resolution.configured.engine.assemble(params);
      } catch (error) {
        thrown = error;
      }
      // Drain an accidental async rejection before asserting synchronous error identity.
      await returned?.catch(() => {});
      expect(thrown).toBe(syncFailure);
      expect(assemble).toHaveBeenCalledTimes(2);
      expect(listContextEngineQuarantines()).toEqual(quarantine);
    } finally {
      await Promise.allSettled([
        processEngine.dispose?.(),
        resolution.configured.engine.dispose?.(),
        resolution.fallback.engine.dispose?.(),
      ]);
    }
  });
});

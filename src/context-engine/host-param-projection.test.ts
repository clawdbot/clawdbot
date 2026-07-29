import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../agents/runtime/index.js";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import {
  listContextEngineQuarantines,
  registerContextEngineForOwner,
  resolveContextEngine,
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
      }) satisfies ContextEngine,
    `test:${engineId}`,
  );
  return engineId;
}

async function invokeHostParamMethods(engine: ContextEngine) {
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
  });
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
    const engineId = registerProbeEngine({
      acceptedHostParams: [
        "sessionKey",
        "prompt",
        "runtimeSettings",
        "sessionTarget",
        "runtimeContext",
      ],
      assembleCalls,
      compactCalls,
    });

    await invokeHostParamMethods(
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
    });
  });

  it("uses the legacy parameter set for undeclared engines during the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00Z"));
    const assembleCalls: Array<Record<string, unknown>> = [];
    const compactCalls: Array<Record<string, unknown>> = [];
    const engineId = registerProbeEngine({ assembleCalls, compactCalls });

    await invokeHostParamMethods(
      await resolveContextEngine({ plugins: { slots: { contextEngine: engineId } } }),
    );

    for (const call of [...assembleCalls, ...compactCalls]) {
      expect(call).not.toHaveProperty("sessionKey");
      expect(call).not.toHaveProperty("runtimeSettings");
    }
    expect(assembleCalls[0]).not.toHaveProperty("prompt");
    expect(compactCalls[0]).not.toHaveProperty("sessionTarget");
    expect(compactCalls[0]).not.toHaveProperty("runtimeContext");
    expect(compactCalls[0]).toHaveProperty("sessionId", "session-1");
  });

  it("passes full host parameters to undeclared engines after the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00Z"));
    const assembleCalls: Array<Record<string, unknown>> = [];
    const compactCalls: Array<Record<string, unknown>> = [];
    const engineId = registerProbeEngine({ assembleCalls, compactCalls });
    const engine = await resolveContextEngine({ plugins: { slots: { contextEngine: engineId } } });

    vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
    await invokeHostParamMethods(engine);

    expect(assembleCalls[0]).toHaveProperty("sessionKey", "agent:main:session-1");
    expect(assembleCalls[0]).toHaveProperty("prompt", "hello");
    expect(compactCalls[0]).toHaveProperty("runtimeContext", { tokenBudget: 1000 });
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
});

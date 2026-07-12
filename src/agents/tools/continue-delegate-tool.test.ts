import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingDelegates,
  consumePendingDelegates,
  consumeStagedPostCompactionDelegates,
} from "../../auto-reply/continuation-delegate-store.js";
import {
  resetContinueDelegateTurnAdmissionForTests,
  resetContinueDelegateTurnBudget,
} from "../../auto-reply/continuation/delegate-turn-admission.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import {
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createContinueDelegateTool } from "./continue-delegate-tool.js";

const ACTIVE_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00";
const ACTIVE_TRACE_CONTEXT: DiagnosticTraceContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: "00",
};

describe("continue_delegate tool", () => {
  beforeEach(() => {
    cancelPendingDelegates("test-session");
    consumePendingDelegates("test-session");
    consumeStagedPostCompactionDelegates("test-session");
    resetContinueDelegateTurnAdmissionForTests();
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    cancelPendingDelegates("test-session");
    resetContinueDelegateTurnAdmissionForTests();
    clearRuntimeConfigSnapshot();
    resetDiagnosticTraceContextForTest();
    vi.useRealTimers();
  });

  async function executeTool(
    tool: ReturnType<typeof createContinueDelegateTool>,
    index: number,
    args: Record<string, unknown>,
  ) {
    return (await tool.execute(`call-${index}`, args))?.details as Record<string, unknown>;
  }

  it("reads maxDelegatesPerTurn at execute time instead of tool construction time", async () => {
    const initialConfig: OpenClawConfig = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 5 } } },
    };
    setRuntimeConfigSnapshot(initialConfig);
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const updatedConfig: OpenClawConfig = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 10 } } },
    };
    setRuntimeConfigSnapshot(updatedConfig);

    for (let index = 0; index < 10; index += 1) {
      const result = await executeTool(tool, index, { task: `delegate ${index + 1}` });
      expect(result).toMatchObject({ status: "scheduled" });
    }

    const overflow = await executeTool(tool, 10, { task: "delegate 11" });
    expect(overflow).toMatchObject({
      status: "rejected",
      guard: "maxDelegatesPerTurn",
      limit: 10,
      delegatesThisTurn: 10,
    });
    expect(overflow.reason).toBe(
      "would exceed maxDelegatesPerTurn cap (10/10 already scheduled this turn)",
    );
  });

  it("re-reads maxDelegatesPerTurn on each call", async () => {
    const initialConfig: OpenClawConfig = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 10 } } },
    };
    setRuntimeConfigSnapshot(initialConfig);
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    for (let index = 0; index < 5; index += 1) {
      const result = await executeTool(tool, index, { task: `delegate ${index + 1}` });
      expect(result).toMatchObject({ status: "scheduled" });
    }

    const updatedConfig: OpenClawConfig = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 5 } } },
    };
    setRuntimeConfigSnapshot(updatedConfig);

    const overflow = await executeTool(tool, 5, { task: "delegate 6" });
    expect(overflow).toMatchObject({
      status: "rejected",
      guard: "maxDelegatesPerTurn",
      limit: 5,
      delegatesThisTurn: 5,
    });
    expect(overflow.reason).toBe(
      "would exceed maxDelegatesPerTurn cap (5/5 already scheduled this turn)",
    );
  });

  it("uses the runtime default of 5 when maxDelegatesPerTurn is unset", async () => {
    // Pin an empty config so the test doesn't pick up host-level openclaw.json.
    setRuntimeConfigSnapshot({});
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    for (let index = 0; index < 5; index += 1) {
      const result = await executeTool(tool, index, { task: `delegate ${index + 1}` });
      expect(result).toMatchObject({ status: "scheduled" });
    }

    const overflow = await executeTool(tool, 5, { task: "delegate 6" });
    expect(overflow).toMatchObject({
      status: "rejected",
      guard: "maxDelegatesPerTurn",
      limit: 5,
      delegatesThisTurn: 5,
    });
    expect(overflow.reason).toBe(
      "would exceed maxDelegatesPerTurn cap (5/5 already scheduled this turn)",
    );
  });

  it("does not expose diagnostic traceparent as a model-facing parameter", () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    expect(JSON.stringify(tool.parameters)).not.toContain("traceparent");
  });

  it("resets the per-turn budget at the provider-turn boundary for the same tool instance", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 2 } } },
    });
    // The embedded runner builds the tool list once per run; the SAME instance
    // is reused across every assistant turn. Far-future queued delegates must
    // not permanently consume the budget across turns (#1144 r3514647794).
    const runTool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    await expect(
      executeTool(runTool, 0, { task: "delayed delegate 1", delaySeconds: 86_400 }),
    ).resolves.toMatchObject({ status: "scheduled", delegatesThisTurn: 1 });
    await expect(
      executeTool(runTool, 1, { task: "delayed delegate 2", delaySeconds: 86_400 }),
    ).resolves.toMatchObject({ status: "scheduled", delegatesThisTurn: 2 });
    await expect(executeTool(runTool, 2, { task: "same-turn overflow" })).resolves.toMatchObject({
      status: "rejected",
      guard: "maxDelegatesPerTurn",
      delegatesThisTurn: 2,
      limit: 2,
      pendingQueuedDelegates: 2,
      scheduledPendingDelegates: 2,
      stagedPostCompactionDelegates: 0,
    });

    // New provider-turn boundary resets the budget.
    resetContinueDelegateTurnBudget("test-session");

    // The SAME tool instance now gets a fresh budget for the new turn.
    await expect(executeTool(runTool, 3, { task: "fresh turn immediate" })).resolves.toMatchObject({
      status: "scheduled",
      delegateIndex: 1,
      delegatesThisTurn: 1,
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({ task: "fresh turn immediate" }),
    ]);
  });

  it("accepts string-encoded delaySeconds values", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "delayed delegate",
      delaySeconds: "5",
      mode: "silent",
    });

    expect(result).toMatchObject({
      status: "scheduled",
      delaySeconds: 5,
      mode: "silent",
    });
  });

  it("clamps queued delegate delays to runtime bounds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:00:00.000Z"));
    setRuntimeConfigSnapshot({
      agents: {
        defaults: {
          continuation: {
            minDelayMs: 1_000,
            maxDelayMs: 2_000,
          },
        },
      },
    });
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "clamped delayed delegate",
      delaySeconds: 999,
    });

    expect(result).toMatchObject({
      status: "scheduled",
      delaySeconds: 2,
    });
    expect(consumePendingDelegates("test-session")).toEqual([]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({ task: "clamped delayed delegate", delayMs: 2_000 }),
    ]);
  });

  it("accepts mixed-case delegate mode values", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "mixed-case mode delegate",
      mode: "Silent-Wake",
    });

    expect(result).toMatchObject({
      status: "scheduled",
      mode: "silent-wake",
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({ task: "mixed-case mode delegate", mode: "silent-wake" }),
    ]);
  });

  it("normalizes provider-supplied empty target arrays away for default silent-wake returns", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "default return without explicit targets",
      mode: "silent-wake",
      targetSessionKeys: [],
    });

    expect(result).toMatchObject({
      status: "scheduled",
      mode: "silent-wake",
    });
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("targetSessionKey");
    expect(result).not.toHaveProperty("targetSessionKeys");
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "default return without explicit targets",
        mode: "silent-wake",
      }),
    ]);
  });

  it("normalizes empty targetSessionKey away for default silent returns", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "silent default return",
      mode: "silent",
      targetSessionKey: "",
    });

    expect(result).toMatchObject({
      status: "scheduled",
      mode: "silent",
    });
    expect(result).not.toHaveProperty("targetSessionKey");
    expect(result).not.toHaveProperty("targetSessionKeys");
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "silent default return",
        mode: "silent",
      }),
    ]);
  });

  it("persists singular cross-session target metadata", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { crossSessionTargeting: "enabled" } } },
    });
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "return to root",
      targetSessionKey: "agent:main:root",
    });

    expect(result).toMatchObject({
      status: "scheduled",
      targetSessionKey: "agent:main:root",
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "return to root",
        targetSessionKey: "agent:main:root",
      }),
    ]);
  });

  it("accepts targeted silent-wake returns without fanoutMode", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { crossSessionTargeting: "enabled" } } },
    });
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "targeted return",
      mode: "silent-wake",
      targetSessionKey: "agent:main:discord:channel:1466192485440164011",
    });

    expect(result).toMatchObject({
      status: "scheduled",
      mode: "silent-wake",
      targetSessionKey: "agent:main:discord:channel:1466192485440164011",
    });
    expect(result).not.toHaveProperty("fanoutMode");
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "targeted return",
        mode: "silent-wake",
        targetSessionKey: "agent:main:discord:channel:1466192485440164011",
      }),
    ]);
  });

  it("persists multi-recipient target metadata from snake_case input", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { crossSessionTargeting: "enabled" } } },
    });
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "return to siblings",
      target_session_keys: ["agent:main:root", " agent:main:sibling ", "agent:main:root"],
    });

    expect(result).toMatchObject({
      status: "scheduled",
      targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "return to siblings",
        targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
      }),
    ]);
  });

  it("persists tree/all fanout metadata", async () => {
    const treeTool = createContinueDelegateTool({ agentSessionKey: "test-session" });
    const treeResult = await executeTool(treeTool, 0, {
      task: "return up the chain",
      fanoutMode: "tree",
    });

    expect(treeResult).toMatchObject({
      status: "scheduled",
      fanoutMode: "tree",
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({ task: "return up the chain", fanoutMode: "tree" }),
    ]);

    const allTool = createContinueDelegateTool({ agentSessionKey: "test-session" });
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { crossSessionTargeting: "enabled" } } },
    });
    const allResult = await executeTool(allTool, 0, {
      task: "return to everyone",
      fanout_mode: "ALL",
    });

    expect(allResult).toMatchObject({
      status: "scheduled",
      fanoutMode: "all",
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({ task: "return to everyone", fanoutMode: "all" }),
    ]);
  });

  it("accepts tree fanout without explicit target keys", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "fan out to ancestors",
      mode: "silent-wake",
      fanoutMode: "tree",
    });

    expect(result).toMatchObject({
      status: "scheduled",
      mode: "silent-wake",
      fanoutMode: "tree",
    });
    expect(result).not.toHaveProperty("targetSessionKey");
    expect(result).not.toHaveProperty("targetSessionKeys");
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "fan out to ancestors",
        mode: "silent-wake",
        fanoutMode: "tree",
      }),
    ]);
  });

  it("auto-picks the active runtime trace context when traceparent is omitted", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await runWithDiagnosticTraceContext(ACTIVE_TRACE_CONTEXT, () =>
      executeTool(tool, 0, {
        task: "continue active traced chain",
      }),
    );

    expect(result).toMatchObject({
      status: "scheduled",
    });
    expect(result).not.toHaveProperty("traceparent");
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "continue active traced chain",
        traceparent: ACTIVE_TRACEPARENT,
      }),
    ]);
  });

  it("falls back to the active runtime trace context when a hidden traceparent is invalid", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await runWithDiagnosticTraceContext(ACTIVE_TRACE_CONTEXT, () =>
      executeTool(tool, 0, {
        task: "ignore malformed hidden traceparent",
        traceparent: "not-a-traceparent",
      }),
    );

    expect(result).toMatchObject({
      status: "scheduled",
    });
    expect(result).not.toHaveProperty("traceparent");
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "ignore malformed hidden traceparent",
        traceparent: ACTIVE_TRACEPARENT,
      }),
    ]);
  });

  it("omits traceparent when the carrier is absent", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    await executeTool(tool, 0, { task: "continue untraced chain" });

    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(1);
    expect(expectDefined(delegates.at(0), "delegate").traceparent).toBeUndefined();
  });

  it("fails loudly for invalid target arrays and fanout conflicts", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    await expect(
      tool.execute("call-invalid-array", {
        task: "bad targets",
        targetSessionKeys: "agent:main:root",
      }),
    ).rejects.toThrow("targetSessionKeys must be an array of non-empty strings");

    await expect(
      tool.execute("call-invalid-entry", {
        task: "bad target entry",
        targetSessionKeys: ["agent:main:root", ""],
      }),
    ).rejects.toThrow("targetSessionKeys must contain only non-empty strings");

    await expect(
      tool.execute("call-conflict", {
        task: "conflicting targets",
        targetSessionKey: "agent:main:root",
        fanoutMode: "tree",
      }),
    ).rejects.toThrow(
      "For a targeted return, use targetSessionKey or targetSessionKeys and omit fanoutMode.",
    );
  });

  it("stages post-compaction delegates as silent-wake delegates", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "carry compacted working state forward",
      mode: "post-compaction",
    });

    expect(result).toMatchObject({
      status: "queued-for-compaction",
      mode: "post-compaction",
    });
    expect(consumeStagedPostCompactionDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "carry compacted working state forward",
        silent: true,
        silentWake: true,
      }),
    ]);
  });

  it("threads active runtime traceparent into staged post-compaction delegates", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await runWithDiagnosticTraceContext(ACTIVE_TRACE_CONTEXT, () =>
      executeTool(tool, 0, {
        task: "carry traced compacted working state forward",
        mode: "post-compaction",
      }),
    );

    expect(result).toMatchObject({
      status: "queued-for-compaction",
    });
    expect(result).not.toHaveProperty("traceparent");
    expect(consumeStagedPostCompactionDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "carry traced compacted working state forward",
        traceparent: ACTIVE_TRACEPARENT,
      }),
    ]);
  });

  it("threads a model override into the enqueued delegate", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "route to a cheaper model",
      model: "github-copilot/claude-haiku-4.5",
    });

    expect(result).toMatchObject({
      status: "scheduled",
      model: "github-copilot/claude-haiku-4.5",
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "route to a cheaper model",
        model: "github-copilot/claude-haiku-4.5",
      }),
    ]);
  });

  it("omits the model override when none is provided (inherits the parent model)", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, { task: "inherit parent model" });

    expect(result).not.toHaveProperty("model");
    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(1);
    expect(expectDefined(delegates.at(0), "delegate").model).toBeUndefined();
  });

  it('treats model="default" as no override (inherits the parent model)', async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "explicit default model",
      model: "default",
    });

    expect(result).not.toHaveProperty("model");
    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(1);
    expect(expectDefined(delegates.at(0), "delegate").model).toBeUndefined();
  });

  it("threads the model override into staged post-compaction delegates", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "carry compacted state to a specific model",
      mode: "post-compaction",
      model: "github-copilot/claude-sonnet-4.6",
    });

    expect(result).toMatchObject({
      status: "queued-for-compaction",
      model: "github-copilot/claude-sonnet-4.6",
    });
    expect(consumeStagedPostCompactionDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "carry compacted state to a specific model",
        model: "github-copilot/claude-sonnet-4.6",
      }),
    ]);
  });
});

// Verifies sessions_spawn model, thinking, timeout, and accepted-note planning.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { resolveConfiguredSubagentSpawnModelSelection } from "./model-selection.js";
import { resolveSubagentSpawnAcceptedNote } from "./subagents/spawn/subagent-spawn-accepted-note.js";
import {
  resolveConfiguredSubagentRunTimeoutSeconds,
  resolveSubagentModelAndThinkingPlan,
  splitModelRef,
} from "./subagents/spawn/subagent-spawn-plan.js";
import { resolveSubagentThinkingOverride } from "./subagents/spawn/subagent-spawn-thinking.js";

type SubagentModelPlan = ReturnType<typeof resolveSubagentModelAndThinkingPlan>;
type OkSubagentModelPlan = Extract<SubagentModelPlan, { status: "ok" }>;

function createConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" },
    ...overrides,
  } as OpenClawConfig;
}

function expectOkPlan(plan: SubagentModelPlan): OkSubagentModelPlan {
  // Narrows the discriminated plan before checking the resolved patch details.
  expect(plan.status).toBe("ok");
  if (plan.status !== "ok") {
    throw new Error(`Expected ok plan, received ${plan.status}`);
  }
  return plan;
}

describe("subagent spawn model + thinking plan", () => {
  it("includes explicit model overrides in the initial patch", () => {
    const plan = expectOkPlan(
      resolveSubagentModelAndThinkingPlan({
        cfg: createConfig(),
        targetAgentId: "research",
        modelOverride: "claude-haiku-4-5",
      }),
    );
    expect(plan.resolvedModel).toBe("claude-haiku-4-5");
    expect(plan.modelApplied).toBe(true);
    expect(plan.initialSessionPatch.model).toBe("claude-haiku-4-5");
    expect(plan.initialSessionPatch.modelOverrideSource).toBe("user");
  });

  it("preserves model ids containing slashes", () => {
    expect(splitModelRef("openrouter/meta-llama/llama-3.3-70b:free")).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b:free",
    });
  });

  it("normalizes thinking overrides into the initial patch", () => {
    const plan = expectOkPlan(
      resolveSubagentModelAndThinkingPlan({
        cfg: createConfig(),
        targetAgentId: "research",
        thinkingOverrideRaw: "high",
      }),
    );
    expect(plan.thinkingOverride).toBe("high");
    expect(plan.initialSessionPatch.thinkingLevel).toBe("high");
  });

  it("threads explicit fast mode into the initial child session patch", () => {
    const plan = expectOkPlan(
      resolveSubagentModelAndThinkingPlan({
        cfg: createConfig(),
        targetAgentId: "research",
        fastMode: "auto",
      }),
    );
    expect(plan.initialSessionPatch.fastMode).toBe("auto");
  });

  it("rejects invalid thinking levels before any runtime work", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig(),
      targetAgentId: "research",
      thinkingOverrideRaw: "banana",
    });
    expect(plan.status).toBe("error");
    if (plan.status === "error") {
      expect(plan.error).toMatch(/Invalid thinking level/i);
    }
  });

  it("applies default subagent model from defaults config", () => {
    const plan = expectOkPlan(
      resolveSubagentModelAndThinkingPlan({
        cfg: createConfig({
          agents: { defaults: { subagents: { model: "minimax/MiniMax-M2.7" } } },
        }),
        targetAgentId: "research",
      }),
    );
    expect(plan.resolvedModel).toBe("minimax/MiniMax-M2.7");
    expect(plan.initialSessionPatch.model).toBe("minimax/MiniMax-M2.7");
    expect(plan.initialSessionPatch.modelOverrideSource).toBe("auto");
    expect(plan.initialSessionPatch.modelOverrideFallbackOriginProvider).toBe("minimax");
    expect(plan.initialSessionPatch.modelOverrideFallbackOriginModel).toBe("MiniMax-M2.7");
  });

  it("falls back to runtime default model when no model config is set", () => {
    const plan = expectOkPlan(
      resolveSubagentModelAndThinkingPlan({
        cfg: createConfig(),
        targetAgentId: "research",
      }),
    );
    const defaultModelRef = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
    expect(plan.resolvedModel).toBe(defaultModelRef);
    expect(plan.initialSessionPatch.model).toBe(defaultModelRef);
    expect(plan.initialSessionPatch.modelOverrideSource).toBe("auto");
    expect(plan.initialSessionPatch.modelOverrideFallbackOriginProvider).toBeUndefined();
    expect(plan.initialSessionPatch.modelOverrideFallbackOriginModel).toBeUndefined();
  });

  it("uses the target default provider for bare configured subagent models", () => {
    const plan = expectOkPlan(
      resolveSubagentModelAndThinkingPlan({
        cfg: createConfig({
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
              subagents: { model: "gpt-5.4" },
            },
          },
        }),
        targetAgentId: "research",
      }),
    );
    expect(plan.resolvedModel).toBe("gpt-5.4");
    expect(plan.initialSessionPatch.modelOverrideFallbackOriginProvider).toBe("openai");
    expect(plan.initialSessionPatch.modelOverrideFallbackOriginModel).toBe("gpt-5.4");
  });

  it("can resolve only explicit or configured subagent model selections", () => {
    expect(
      resolveConfiguredSubagentSpawnModelSelection({
        cfg: createConfig(),
        agentId: "research",
      }),
    ).toBeUndefined();
    expect(
      resolveConfiguredSubagentSpawnModelSelection({
        cfg: createConfig({
          agents: { defaults: { subagents: { model: "minimax/MiniMax-M2.7" } } },
        }),
        agentId: "research",
      }),
    ).toBe("minimax/MiniMax-M2.7");
  });

  it.each([
    {
      name: "per-agent subagent model over defaults",
      defaults: { subagents: { model: "minimax/MiniMax-M2.7" } },
      targetAgentConfig: { id: "research", subagents: { model: "opencode/claude" } },
      expectedModel: "opencode/claude",
      expectedProvider: "opencode",
      expectedOriginModel: "claude",
    },
    {
      name: "default subagent model over target agent primary model",
      defaults: { subagents: { model: "minimax/MiniMax-M2.7" } },
      targetAgentConfig: { id: "research", model: { primary: "opencode/claude" } },
      expectedModel: "minimax/MiniMax-M2.7",
      expectedProvider: "minimax",
      expectedOriginModel: "MiniMax-M2.7",
    },
    {
      name: "target agent primary model over global default",
      defaults: { model: { primary: "minimax/MiniMax-M2.7" } },
      targetAgentConfig: { id: "research", model: { primary: "opencode/claude" } },
      expectedModel: "opencode/claude",
      expectedProvider: "opencode",
      expectedOriginModel: "claude",
    },
  ])("prefers $name", (row) => {
    const cfg = createConfig({
      agents: { defaults: row.defaults, list: [row.targetAgentConfig] },
    });
    const plan = expectOkPlan(
      resolveSubagentModelAndThinkingPlan({
        cfg,
        targetAgentId: "research",
        targetAgentConfig: row.targetAgentConfig,
      }),
    );
    expect(plan.resolvedModel).toBe(row.expectedModel);
    expect(plan.initialSessionPatch.model).toBe(row.expectedModel);
    expect(plan.initialSessionPatch.modelOverrideSource).toBe("auto");
    expect(plan.initialSessionPatch.modelOverrideFallbackOriginProvider).toBe(row.expectedProvider);
    expect(plan.initialSessionPatch.modelOverrideFallbackOriginModel).toBe(row.expectedOriginModel);
  });

  it.each([
    {
      name: "uses config default timeout when agent omits runTimeoutSeconds",
      configured: 120,
      explicit: undefined,
      expected: 120,
    },
    {
      name: "explicit runTimeoutSeconds wins over config default",
      configured: 120,
      explicit: 2,
      expected: 2,
    },
    {
      name: "falls back to 0 when config omits the timeout",
      configured: undefined,
      explicit: undefined,
      expected: 0,
    },
  ])("$name", ({ configured, explicit, expected }) => {
    expect(
      resolveConfiguredSubagentRunTimeoutSeconds({
        cfg: createConfig({
          agents: {
            defaults: {
              subagents:
                configured === undefined ? { maxConcurrent: 8 } : { runTimeoutSeconds: configured },
            },
          },
        }),
        runTimeoutSeconds: explicit,
      }),
    ).toBe(expected);
  });
});

type ThinkingLevel = "high" | "medium" | "low" | "off";

function expectResolvedThinkingPlan(input: {
  expected: ThinkingLevel;
  expectedOverride?: ThinkingLevel | null;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  cfg?: OpenClawConfig;
}) {
  const cfg =
    input.cfg ??
    (createConfig({ agents: { defaults: { subagents: { thinking: "high" } } } }) as OpenClawConfig);
  const plan = resolveSubagentThinkingOverride({
    cfg,
    requesterAgentConfig: input.requesterAgentConfig,
    targetAgentConfig: input.targetAgentConfig,
    thinkingOverrideRaw: input.thinkingOverrideRaw,
    callerThinkingRaw: input.callerThinkingRaw,
  });

  expect(plan).toEqual({
    status: "ok",
    thinkingOverride:
      input.expectedOverride === null ? undefined : (input.expectedOverride ?? input.expected),
    initialSessionPatch: { thinkingLevel: input.expected },
  });
}

describe("sessions_spawn thinking defaults", () => {
  it.each([
    {
      name: "applies agents.defaults.subagents.thinking when thinking is omitted",
      expected: "high",
    },
    {
      name: "prefers explicit sessions_spawn.thinking over config default",
      thinkingOverrideRaw: "low",
      expected: "low",
    },
    {
      name: "prefers per-agent subagent thinking over global subagent thinking",
      targetAgentConfig: { subagents: { thinking: "medium" } },
      expected: "medium",
    },
    {
      name: "prefers requester-agent subagent thinking over target-agent subagent thinking",
      requesterAgentConfig: { subagents: { thinking: "low" } },
      targetAgentConfig: { subagents: { thinking: "medium" } },
      callerThinkingRaw: "high",
      expected: "low",
    },
    {
      name: "inherits caller thinking when no explicit or configured subagent thinking exists",
      cfg: createConfig({ agents: { defaults: {} } }),
      callerThinkingRaw: "medium",
      expected: "medium",
      expectedOverride: null,
    },
    {
      name: "prefers global subagent thinking over caller thinking",
      callerThinkingRaw: "medium",
      expected: "high",
    },
    {
      name: "preserves caller thinking off when inherited",
      cfg: createConfig({ agents: { defaults: {} } }),
      callerThinkingRaw: "off",
      expected: "off",
      expectedOverride: null,
    },
    {
      name: "preserves explicit thinking off",
      thinkingOverrideRaw: "off",
      expected: "off",
    },
    {
      name: "preserves configured subagent thinking off",
      targetAgentConfig: { subagents: { thinking: "off" } },
      callerThinkingRaw: "high",
      expected: "off",
    },
  ] as const)("$name", (row) => {
    expectResolvedThinkingPlan(row);
  });
});

describe("sessions_spawn accepted notes", () => {
  it.each([
    {
      name: "suppresses ACCEPTED_NOTE for cron isolated sessions (mode=run)",
      agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
      expected: undefined,
    },
    {
      name: "preserves ACCEPTED_NOTE for regular sessions (mode=run)",
      agentSessionKey: "agent:main:telegram:63448508",
      expected: "Auto-announce is push-based",
    },
    {
      name: "preserves ACCEPTED_NOTE for non-canonical cron-like keys",
      agentSessionKey: "agent:main:slack:cron:job:run:uuid",
      expected: "Auto-announce is push-based",
    },
    {
      name: "preserves ACCEPTED_NOTE when agentSessionKey is undefined",
      agentSessionKey: undefined,
      expected: "Auto-announce is push-based",
    },
  ])("$name", ({ agentSessionKey, expected }) => {
    const note = resolveSubagentSpawnAcceptedNote({ spawnMode: "run", agentSessionKey });
    if (expected === undefined) {
      expect(note).toBeUndefined();
    } else {
      expect(note).toContain(expected);
    }
  });

  it("keeps regular run guidance push-based without recommending sessions_yield", () => {
    const note = resolveSubagentSpawnAcceptedNote({ spawnMode: "run" });

    expect(note).toContain("Auto-announce is push-based");
    expect(note).toContain("Continue any independent work");
    expect(note).toContain("wait for runtime completion events to arrive as user messages");
    expect(note).toContain("only answer after completion events for ALL required children arrive");
    expect(note).not.toContain("sessions_yield");
  });

  it("uses the session note for cron session-mode spawns", () => {
    expect(
      resolveSubagentSpawnAcceptedNote({
        spawnMode: "session",
        agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
      }),
    ).toBe("thread-bound session stays active after this task; continue in-thread for follow-ups.");
  });
});

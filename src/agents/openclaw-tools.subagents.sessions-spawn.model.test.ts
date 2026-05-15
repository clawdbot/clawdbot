import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  resolveConfiguredSubagentRunTimeoutSeconds,
  resolveSubagentModelAndThinkingPlan,
  splitModelRef,
} from "./subagent-spawn-plan.js";

type SubagentModelPlan = ReturnType<typeof resolveSubagentModelAndThinkingPlan>;
type OkSubagentModelPlan = Extract<SubagentModelPlan, { status: "ok" }>;

function createConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" },
    ...overrides,
  } as OpenClawConfig;
}

function expectOkPlan(plan: SubagentModelPlan): OkSubagentModelPlan {
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
  });

  it("prefers per-agent subagent model over defaults", () => {
    const cfg = createConfig({
      agents: {
        defaults: { subagents: { model: "minimax/MiniMax-M2.7" } },
        list: [{ id: "research", subagents: { model: "opencode/claude" } }],
      },
    });
    const targetAgentConfig = {
      id: "research",
      subagents: { model: "opencode/claude" },
    };
    const plan = expectOkPlan(
      resolveSubagentModelAndThinkingPlan({
        cfg,
        targetAgentId: "research",
        targetAgentConfig,
      }),
    );
    expect(plan.resolvedModel).toBe("opencode/claude");
    expect(plan.initialSessionPatch.model).toBe("opencode/claude");
    expect(plan.initialSessionPatch.modelOverrideSource).toBe("auto");
  });

  it("prefers default subagent model over target agent primary model", () => {
    const cfg = createConfig({
      agents: {
        defaults: { subagents: { model: "minimax/MiniMax-M2.7" } },
        list: [{ id: "research", model: { primary: "opencode/claude" } }],
      },
    });
    const targetAgentConfig = {
      id: "research",
      model: { primary: "opencode/claude" },
    };
    const plan = expectOkPlan(
      resolveSubagentModelAndThinkingPlan({
        cfg,
        targetAgentId: "research",
        targetAgentConfig,
      }),
    );
    expect(plan.resolvedModel).toBe("minimax/MiniMax-M2.7");
    expect(plan.initialSessionPatch.model).toBe("minimax/MiniMax-M2.7");
    expect(plan.initialSessionPatch.modelOverrideSource).toBe("auto");
  });

  it("prefers target agent primary model over global default", () => {
    const cfg = createConfig({
      agents: {
        defaults: { model: { primary: "minimax/MiniMax-M2.7" } },
        list: [{ id: "research", model: { primary: "opencode/claude" } }],
      },
    });
    const targetAgentConfig = {
      id: "research",
      model: { primary: "opencode/claude" },
    };
    const plan = expectOkPlan(
      resolveSubagentModelAndThinkingPlan({
        cfg,
        targetAgentId: "research",
        targetAgentConfig,
      }),
    );
    expect(plan.resolvedModel).toBe("opencode/claude");
    expect(plan.initialSessionPatch.model).toBe("opencode/claude");
    expect(plan.initialSessionPatch.modelOverrideSource).toBe("auto");
  });

  it("uses config default timeout when agent omits runTimeoutSeconds", () => {
    expect(
      resolveConfiguredSubagentRunTimeoutSeconds({
        cfg: createConfig({
          agents: { defaults: { subagents: { runTimeoutSeconds: 120 } } },
        }),
      }),
    ).toBe(120);
  });

  it("explicit runTimeoutSeconds wins over config default", () => {
    expect(
      resolveConfiguredSubagentRunTimeoutSeconds({
        cfg: createConfig({
          agents: { defaults: { subagents: { runTimeoutSeconds: 120 } } },
        }),
        runTimeoutSeconds: 2,
      }),
    ).toBe(2);
  });

  it("falls back to 0 when config omits the timeout", () => {
    expect(
      resolveConfiguredSubagentRunTimeoutSeconds({
        cfg: createConfig({
          agents: { defaults: { subagents: { maxConcurrent: 8 } } },
        }),
      }),
    ).toBe(0);
  });
});

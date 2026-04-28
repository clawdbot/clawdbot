import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  resolveConfiguredSubagentRunTimeoutSeconds,
  resolveSubagentModelAndThinkingPlan,
  splitModelRef,
} from "./subagent-spawn-plan.js";

function createConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" },
    ...overrides,
  } as OpenClawConfig;
}

describe("subagent spawn model + thinking plan", () => {
  it("includes explicit model overrides in the initial patch", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig(),
      targetAgentId: "research",
      modelOverride: "claude-haiku-4-5",
    });
    expect(plan).toMatchObject({
      status: "ok",
      resolvedModel: "claude-haiku-4-5",
      modelApplied: true,
      initialSessionPatch: {
        model: "claude-haiku-4-5",
        modelOverrideSource: "user",
      },
    });
  });

  it("preserves model ids containing slashes", () => {
    expect(splitModelRef("openrouter/meta-llama/llama-3.3-70b:free")).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b:free",
    });
  });

  it("normalizes thinking overrides into the initial patch", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig(),
      targetAgentId: "research",
      thinkingOverrideRaw: "high",
    });
    expect(plan).toMatchObject({
      status: "ok",
      thinkingOverride: "high",
      initialSessionPatch: {
        thinkingLevel: "high",
      },
    });
  });

  it("rejects invalid thinking levels before any runtime work", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig(),
      targetAgentId: "research",
      thinkingOverrideRaw: "banana",
    });
    expect(plan).toMatchObject({
      status: "error",
    });
    if (plan.status === "error") {
      expect(plan.error).toMatch(/Invalid thinking level/i);
    }
  });

  it("applies default subagent model from defaults config", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig({
        agents: { defaults: { subagents: { model: "minimax/MiniMax-M2.7" } } },
      }),
      targetAgentId: "research",
    });
    expect(plan).toMatchObject({
      status: "ok",
      resolvedModel: "minimax/MiniMax-M2.7",
      initialSessionPatch: { model: "minimax/MiniMax-M2.7", modelOverrideSource: "auto" },
    });
  });

  it("falls back to runtime default model when no model config is set", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: createConfig(),
      targetAgentId: "research",
    });
    expect(plan).toMatchObject({
      status: "ok",
      resolvedModel: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      initialSessionPatch: { model: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}` },
    });
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
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg,
      targetAgentId: "research",
      targetAgentConfig,
    });
    expect(plan).toMatchObject({
      status: "ok",
      resolvedModel: "opencode/claude",
      initialSessionPatch: { model: "opencode/claude" },
    });
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
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg,
      targetAgentId: "research",
      targetAgentConfig,
    });
    expect(plan).toMatchObject({
      status: "ok",
      resolvedModel: "opencode/claude",
      initialSessionPatch: { model: "opencode/claude" },
    });
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

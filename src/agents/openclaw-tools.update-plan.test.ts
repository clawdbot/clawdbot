import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isUpdatePlanToolEnabledForOpenClawTools } from "./openclaw-tools.registration.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";

describe("openclaw-tools update_plan gating", () => {
  it("keeps update_plan disabled by default", () => {
    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: {} as OpenClawConfig,
      }),
    ).toBe(false);
  });

  it("registers update_plan when explicitly enabled", () => {
    const config = {
      tools: {
        experimental: {
          planTool: true,
        },
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config,
      }),
    ).toBe(true);
    expect(createUpdatePlanTool().displaySummary).toBe("Track a short structured work plan.");
  });

  it("auto-enables update_plan for unconfigured GPT-5 openai runs", () => {
    // Criterion 1 of the GPT-5.4 parity gate ("no stalls after planning") is
    // universal, not opt-in. Unspecified executionContract on a supported
    // provider/model auto-activates strict-agentic so unconfigured installs
    // get the same behavior as explicit opt-in. Explicit "default" still
    // opts out (see "respects explicit default contract opt-out" below).
    const cfg = {
      agents: {
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBe(true);
    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "openai-codex",
        modelId: "gpt-5.4",
      }),
    ).toBe(true);
  });

  it("respects explicit default contract opt-out on GPT-5 runs", () => {
    // Users who explicitly set executionContract: "default" are saying they
    // want the old pre-parity-program behavior. Honor that opt-out.
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            executionContract: "default",
          },
        },
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBe(false);
  });

  it("does not auto-enable update_plan for non-openai providers even when unconfigured", () => {
    const cfg = {
      agents: {
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-6",
      }),
    ).toBe(false);
    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "openai",
        modelId: "gpt-4.1",
      }),
    ).toBe(false);
  });

  it("auto-enables update_plan for strict-agentic GPT-5 agents", () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            executionContract: "strict-agentic",
          },
        },
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBe(true);
  });

  it("does not auto-enable update_plan for unsupported providers or models", () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            executionContract: "strict-agentic",
          },
        },
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-6",
      }),
    ).toBe(false);
    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "openai",
        modelId: "gpt-4.1",
      }),
    ).toBe(false);
  });

  it("lets explicit planTool false override strict-agentic auto-enable", () => {
    const cfg = {
      tools: {
        experimental: {
          planTool: false,
        },
      },
      agents: {
        defaults: {
          embeddedPi: {
            executionContract: "strict-agentic",
          },
        },
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentSessionKey: "agent:main:main",
        modelProvider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBe(false);
  });

  it("resolves strict-agentic gating from explicit agentId when no session key is available", () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            executionContract: "default",
          },
        },
        list: [
          { id: "main" },
          {
            id: "research",
            embeddedPi: {
              executionContract: "strict-agentic",
            },
          },
        ],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentId: "research",
        modelProvider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBe(true);
  });

  it("applies per-agent overrides without leaking the contract to other agents", () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            executionContract: "strict-agentic",
          },
        },
        list: [
          {
            id: "main",
            embeddedPi: {
              executionContract: "default",
            },
          },
          {
            id: "research",
          },
        ],
      },
    } as OpenClawConfig;

    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentId: "main",
        modelProvider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBe(false);
    expect(
      isUpdatePlanToolEnabledForOpenClawTools({
        config: cfg,
        agentId: "research",
        modelProvider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBe(true);
  });
});

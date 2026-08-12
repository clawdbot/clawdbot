// Tests the ACP-aware branch added to the subagent model configured-model
// resolver. Covers #122708 — runtime === "acp" should consult per-agent and
// default `subagents.acpModel` ahead of `subagents.model` so a harness-correct
// vendor ref (e.g. openai/* for Codex ACP) is selected independently of the
// outer subagent default.
import { describe, expect, it } from "vitest";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveSubagentConfiguredModelSelection } from "./model-selection-config.js";

function cfgWith(
  agent: AgentConfig | undefined,
  defaultsSubagents: AgentDefaultsConfig["subagents"] | undefined,
): OpenClawConfig {
  return {
    agents: {
      defaults: defaultsSubagents !== undefined ? { subagents: defaultsSubagents } : {},
      list: agent ? [agent] : [],
    },
  } as unknown as OpenClawConfig;
}

describe("resolveSubagentConfiguredModelSelection — ACP runtime discriminator (#122708)", () => {
  it("no runtime falls through to subagents.model (no regression)", () => {
    const cfg = cfgWith(undefined, { model: "openrouter/minimax/minimax-m3" });
    expect(resolveSubagentConfiguredModelSelection({ cfg, agentId: "research" })).toBe(
      "openrouter/minimax/minimax-m3",
    );
  });

  it("runtime=acp consults per-agent subagents.acpModel first", () => {
    const cfg = cfgWith(
      {
        id: "research",
        subagents: {
          acpModel: "openai/gpt-5.4",
          model: "openrouter/minimax/minimax-m3",
        },
      },
      { model: "openrouter/minimax/minimax-m3" },
    );
    expect(
      resolveSubagentConfiguredModelSelection({ cfg, agentId: "research", runtime: "acp" }),
    ).toBe("openai/gpt-5.4");
  });

  it("runtime=acp with no per-agent acpModel falls back to default subagents.acpModel", () => {
    const cfg = cfgWith(
      {
        id: "research",
        model: "anthropic/claude-sonnet-4.5",
        subagents: { model: "openrouter/minimax/minimax-m3" },
      },
      { acpModel: "openai/gpt-5.4" },
    );
    expect(
      resolveSubagentConfiguredModelSelection({ cfg, agentId: "research", runtime: "acp" }),
    ).toBe("openai/gpt-5.4");
  });

  it("runtime=acp with no acpModel anywhere falls through to subagents.model", () => {
    const cfg = cfgWith(
      {
        id: "research",
        subagents: { model: "openrouter/minimax/minimax-m3" },
      },
      { model: "openrouter/minimax/minimax-m3" },
    );
    expect(
      resolveSubagentConfiguredModelSelection({ cfg, agentId: "research", runtime: "acp" }),
    ).toBe("openrouter/minimax/minimax-m3");
  });

  it("runtime=acp with no acpModel or subagents.model falls through to agent primary", () => {
    const cfg = cfgWith({ id: "research", model: "anthropic/claude-sonnet-4.5" }, undefined);
    expect(
      resolveSubagentConfiguredModelSelection({ cfg, agentId: "research", runtime: "acp" }),
    ).toBe("anthropic/claude-sonnet-4.5");
  });

  it("per-agent acpModel beats default acpModel when runtime=acp", () => {
    const cfg = cfgWith(
      { id: "research", subagents: { acpModel: "openai/gpt-5.4" } },
      { acpModel: "anthropic/claude-sonnet-4.5" },
    );
    expect(
      resolveSubagentConfiguredModelSelection({ cfg, agentId: "research", runtime: "acp" }),
    ).toBe("openai/gpt-5.4");
  });

  it("includeAgentPrimary=false keeps the runtime=acp ACP selection even when agent primary is set", () => {
    const cfg = cfgWith(
      {
        id: "research",
        model: "openrouter/minimax/minimax-m3",
        subagents: { acpModel: "openai/gpt-5.4" },
      },
      undefined,
    );
    expect(
      resolveSubagentConfiguredModelSelection({
        cfg,
        agentId: "research",
        runtime: "acp",
        includeAgentPrimary: false,
      }),
    ).toBe("openai/gpt-5.4");
  });

  it("object-shape acpModel returns the primary string (mirrors subagents.model behavior)", () => {
    const cfg = cfgWith(
      {
        id: "research",
        subagents: {
          acpModel: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.5"] },
        },
      },
      undefined,
    );
    expect(
      resolveSubagentConfiguredModelSelection({ cfg, agentId: "research", runtime: "acp" }),
    ).toBe("openai/gpt-5.4");
  });
});

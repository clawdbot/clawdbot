import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSubagentSessionDefaultModel } from "./directive-handling.defaults.js";

function makeConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
        models: {
          "openai/gpt-5.6-luna": { alias: "luna" },
        },
        subagents: { model: { primary: "openai/gpt-5.6-luna" } },
      },
      list: [
        {
          id: "main",
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      ],
    },
  } as OpenClawConfig;
}

describe("resolveSubagentSessionDefaultModel", () => {
  it.each([
    { sessionEntry: { spawnDepth: 1 }, label: "spawn depth" },
    { sessionEntry: { subagentRole: "orchestrator" }, label: "subagent role" },
  ] as const)("uses the configured subagent model for $label", ({ sessionEntry }) => {
    expect(
      resolveSubagentSessionDefaultModel({
        cfg: makeConfig(),
        agentId: "main",
        sessionEntry,
        defaultProvider: "anthropic",
      }),
    ).toEqual({ provider: "openai", model: "gpt-5.6-luna" });
  });

  it.each([
    { sessionEntry: {}, label: "a root session" },
    { sessionEntry: { spawnDepth: 0 }, label: "spawn depth zero" },
    {
      sessionEntry: { modelSelectionLocked: true, spawnDepth: 1 },
      label: "a model-locked subagent",
    },
  ] as const)("leaves the parent default unchanged for $label", ({ sessionEntry }) => {
    expect(
      resolveSubagentSessionDefaultModel({
        cfg: makeConfig(),
        agentId: "main",
        sessionEntry,
        defaultProvider: "anthropic",
      }),
    ).toBeNull();
  });

  it("resolves configured subagent aliases", () => {
    const cfg = makeConfig();
    const subagents = cfg.agents?.defaults?.subagents;
    if (!subagents) {
      throw new Error("expected subagent defaults");
    }
    subagents.model = "luna";

    expect(
      resolveSubagentSessionDefaultModel({
        cfg,
        agentId: "main",
        sessionEntry: { spawnDepth: 1 },
        defaultProvider: "anthropic",
      }),
    ).toEqual({ provider: "openai", model: "gpt-5.6-luna" });
  });

  it("resolves agent-scoped subagent aliases", () => {
    const cfg = makeConfig();
    const mainAgent = cfg.agents?.list?.[0];
    if (!mainAgent) {
      throw new Error("expected main agent config");
    }
    mainAgent.models = {
      "openai/gpt-5.6-sol": { alias: "agent-solver" },
    };
    const subagents = cfg.agents?.defaults?.subagents;
    if (!subagents) {
      throw new Error("expected subagent defaults");
    }
    subagents.model = "agent-solver";

    expect(
      resolveSubagentSessionDefaultModel({
        cfg,
        agentId: "main",
        sessionEntry: { spawnDepth: 1 },
        defaultProvider: "anthropic",
      }),
    ).toEqual({ provider: "openai", model: "gpt-5.6-sol" });
  });
});

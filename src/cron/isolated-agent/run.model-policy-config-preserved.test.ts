// Cron policy tests cover per-agent defaults flattening before model resolution.
import { describe, expect, it } from "vitest";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveAllowedModelRef } from "../../agents/model-selection-resolve.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCronAgentDefaultsConfig } from "./run-config.js";

function buildCronConfig(cfg: OpenClawConfig, agentId: string): OpenClawConfig {
  const defaults = buildCronAgentDefaultsConfig({
    defaults: cfg.agents?.defaults,
    agentConfigOverride: resolveAgentConfig(cfg, agentId),
  });
  return {
    ...cfg,
    agents: { ...cfg.agents, defaults },
  };
}

function resolveCronPayloadModel(cfg: OpenClawConfig, raw: string) {
  return resolveAllowedModelRef({
    cfg,
    catalog: [
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    ],
    raw,
    defaultProvider: "openai",
    defaultModel: "baseline",
    manifestPlugins: [],
  });
}

describe("buildCronAgentDefaultsConfig model policy preservation", () => {
  it("keeps the inherited default restriction when the per-agent policy is empty", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        list: [{ id: "worker", modelPolicy: {} }],
      },
    };

    const cronCfg = buildCronConfig(cfg, "worker");

    expect(cronCfg.agents?.defaults?.modelPolicy).toEqual({ allow: ["openai/gpt-5.5"] });
    expect(resolveCronPayloadModel(cronCfg, "openai/gpt-5.6-sol")).toEqual({
      error: "model not allowed: openai/gpt-5.6-sol",
    });
  });

  it("applies an explicit per-agent allowlist to cron model resolution", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        list: [{ id: "worker", modelPolicy: { allow: ["openai/gpt-5.6-sol"] } }],
      },
    };

    const cronCfg = buildCronConfig(cfg, "worker");

    expect(cronCfg.agents?.defaults?.modelPolicy).toEqual({ allow: ["openai/gpt-5.6-sol"] });
    expect(resolveCronPayloadModel(cronCfg, "openai/gpt-5.5")).toEqual({
      error: "model not allowed: openai/gpt-5.5",
    });
    expect(resolveCronPayloadModel(cronCfg, "openai/gpt-5.6-sol")).toMatchObject({
      ref: { provider: "openai", model: "gpt-5.6-sol" },
    });
  });
});

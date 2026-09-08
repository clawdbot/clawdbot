import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayModelThinkingProfile } from "./session-utils-model.js";

describe("Gateway all-null thinking map", () => {
  it("preserves off as the default without selectable levels", () => {
    const profile = resolveGatewayModelThinkingProfile({
      cfg: {},
      agentId: "main",
      provider: "metadata-fixture",
      model: "no-effort",
      agentRuntime: "openclaw",
      modelCatalog: [
        {
          provider: "metadata-fixture",
          id: "no-effort",
          name: "No selectable effort",
          api: "openai-completions",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: null,
            max: null,
          },
        },
      ],
    });

    expect(profile).toEqual({ thinkingLevels: [], thinkingDefault: "off" });
  });
});

describe.each([
  { agentRuntime: "openclaw", api: "openai-responses" as const },
  { agentRuntime: "codex", api: "openai-chatgpt-responses" as const },
])("Gateway model thinking defaults on $agentRuntime", ({ agentRuntime, api }) => {
  it.each<{ name: string; cfg: OpenClawConfig; expected: string }>([
    { name: "provider default", cfg: {}, expected: "low" },
    {
      name: "global override",
      cfg: { agents: { defaults: { thinkingDefault: "high" } } },
      expected: "high",
    },
    {
      name: "model override",
      cfg: {
        agents: {
          defaults: {
            thinkingDefault: "high",
            models: { "openai/gpt-6-astra": { params: { thinking: "medium" } } },
          },
        },
      },
      expected: "medium",
    },
    {
      name: "agent override",
      cfg: { agents: { entries: { main: { thinkingDefault: "xhigh" } } } },
      expected: "xhigh",
    },
  ])("projects $name for Control UI", ({ cfg, expected }) => {
    const profile = resolveGatewayModelThinkingProfile({
      cfg,
      agentId: "main",
      provider: "openai",
      model: "gpt-6-astra",
      agentRuntime,
      modelCatalog: [
        { provider: "openai", id: "gpt-6-astra", name: "Astra", reasoning: true, api },
      ],
    });
    expect(profile.thinkingDefault).toBe(expected);
    expect(profile.thinkingLevels.map(({ id }) => id)).toContain(expected);
  });
});

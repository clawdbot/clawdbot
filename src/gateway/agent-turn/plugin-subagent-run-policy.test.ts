import { describe, expect, it } from "vitest";
import { resolvePluginSubagentDisableTools } from "./plugin-subagent-run-policy.js";
import type { AgentTurnPrincipal } from "./types.js";

function createPrincipal(internal: AgentTurnPrincipal["internal"]): AgentTurnPrincipal {
  return { internal } as AgentTurnPrincipal;
}

describe("plugin subagent run policy", () => {
  it("honors host-stamped tool suppression for plugin subagent runs", () => {
    expect(
      resolvePluginSubagentDisableTools(
        createPrincipal({
          agentRunTracking: "plugin_subagent",
          pluginSubagentDisableTools: true,
        }),
      ),
    ).toBe(true);
  });

  it("ignores tool suppression without plugin subagent tracking", () => {
    expect(
      resolvePluginSubagentDisableTools(createPrincipal({ pluginSubagentDisableTools: true })),
    ).toBe(false);
    expect(resolvePluginSubagentDisableTools(null)).toBe(false);
  });
});

// Verifies gateway client capabilities are hard availability requirements for tools.
import { describe, expect, it, vi } from "vitest";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [
    {
      name: "show_widget",
      label: "Show widget",
      description: "Test capability-gated tool",
      parameters: { type: "object", properties: {} },
      requiredClientCaps: ["inline-widgets"],
      execute: async () => ({ content: [], details: {} }),
    },
  ],
}));

import { createOpenClawCodingTools } from "./agent-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

function hasWidget(tools: readonly { name: string }[]): boolean {
  return tools.some((tool) => tool.name === "show_widget");
}

function hasScreen(tools: readonly { name: string }[]): boolean {
  return tools.some((tool) => tool.name === "screen");
}

function hasTerminal(tools: readonly { name: string }[]): boolean {
  return tools.some((tool) => tool.name === "terminal");
}

describe("gateway client capability tool filtering", () => {
  it("excludes capability-gated tools when no gateway client caps exist", () => {
    expect(hasWidget(createOpenClawTools())).toBe(false);
  });

  it("excludes capability-gated tools when a required cap is absent", () => {
    expect(hasWidget(createOpenClawTools({ clientCaps: ["tool-events"] }))).toBe(false);
  });

  it("includes capability-gated tools when the client caps are a superset", () => {
    expect(hasWidget(createOpenClawTools({ clientCaps: ["tool-events", "inline-widgets"] }))).toBe(
      true,
    );
  });

  it("only exposes screen to UI-command clients", () => {
    expect(hasScreen(createOpenClawTools())).toBe(false);
    expect(hasScreen(createOpenClawTools({ clientCaps: ["ui-commands"] }))).toBe(true);
  });

  it("omits terminal for sandboxed agents", () => {
    expect(hasTerminal(createOpenClawTools({ agentSessionKey: "agent:main:main" }))).toBe(true);
    expect(
      hasTerminal(createOpenClawTools({ agentSessionKey: "agent:main:main", sandboxed: true })),
    ).toBe(false);
  });

  it("does not let tools.allow resurrect a gated tool for a channel run", () => {
    const tools = createOpenClawCodingTools({
      messageProvider: "telegram",
      disableMessageTool: true,
      config: { tools: { allow: ["show_widget"] } },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: true,
      },
    });

    expect(hasWidget(tools)).toBe(false);
  });

  it("filters gated tools on plugin-only construction plans", () => {
    // Regression: plugin-only plans bypass createOpenClawTools, which used to
    // skip the capability gate entirely for narrow allowlists.
    const plan = {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: true,
    };

    expect(
      hasWidget(
        createOpenClawCodingTools({ messageProvider: "telegram", toolConstructionPlan: plan }),
      ),
    ).toBe(false);
    expect(
      hasWidget(
        createOpenClawCodingTools({
          messageProvider: "webchat",
          clientCaps: ["inline-widgets"],
          toolConstructionPlan: plan,
        }),
      ),
    ).toBe(true);
  });
});

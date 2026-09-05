// Scheduled show_widget registration and allowlist coverage.
import { describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

function expectWidget(tools: ReturnType<typeof createOpenClawTools>) {
  const tool = tools.find((candidate) => candidate.name === "show_widget");
  if (!tool) {
    throw new Error("Expected show_widget to be registered");
  }
  return tool;
}

function expectPinnedOnlySchema(tool: ReturnType<typeof expectWidget>): void {
  const schema = tool.parameters as {
    properties?: { pin?: { const?: boolean } };
    required?: string[];
  };
  expect(tool.requiredClientCaps).toBeUndefined();
  expect(schema.required).toContain("pin");
  expect(schema.properties?.pin?.const).toBe(true);
}

describe("scheduled show_widget registration", () => {
  it("exposes a pinned-only widget tool to verified scheduled callers", () => {
    const tool = expectWidget(
      createOpenClawTools({
        agentSessionKey: "agent:main:dashboard:scheduled",
        gatewayCallerScheduled: true,
        runtimeToolAllowlist: ["show_widget"],
      }),
    );

    expectPinnedOnlySchema(tool);
  });

  it("does not let scheduled provenance replace an explicit widget cap", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:dashboard:scheduled",
      gatewayCallerScheduled: true,
    });

    expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
  });

  it("honors an explicit widget deny on the scheduled surface", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:dashboard:scheduled",
      gatewayCallerScheduled: true,
      runtimeToolAllowlist: ["show_widget"],
      config: { tools: { deny: ["show_widget"] } },
    });

    expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
  });

  it("keeps detached scheduled run sessions outside pinned authoring", () => {
    const tools = createOpenClawTools({
      runSessionKey: "agent:main:cron:job:run:scheduled",
      gatewayCallerScheduled: true,
    });

    expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
  });

  it("lets a server-authorized scheduled allowlist select pinned widget authoring", () => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:main:dashboard:scheduled",
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      runtimeToolAllowlist: ["show_widget"],
      config: { tools: { allow: ["show_widget"] } },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expectPinnedOnlySchema(expectWidget(tools));
  });

  it("keeps scheduled turns with a real inline client on the normal widget surface", () => {
    const tool = expectWidget(
      createOpenClawTools({
        agentSessionKey: "agent:main:dashboard:scheduled",
        gatewayCallerScheduled: true,
        runtimeToolAllowlist: ["show_widget"],
        clientCaps: ["inline-widgets"],
      }),
    );
    const schema = tool.parameters as { required?: string[] };

    expect(tool.requiredClientCaps).toEqual(["inline-widgets"]);
    expect(schema.required).not.toContain("pin");
  });
});

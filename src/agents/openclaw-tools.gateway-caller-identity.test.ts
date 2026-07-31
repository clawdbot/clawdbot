// Verifies plugin tools inherit the agent Gateway caller identity from tool assembly.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  observedIdentities: [] as Array<unknown>,
}));

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [
    {
      name: "synthetic_direct_cron_plugin",
      label: "Synthetic direct cron plugin",
      description: "Calls Gateway cron directly like plugin-owned reminder tools.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const { getGatewayToolCallerIdentity } = await import("./tools/gateway-caller-context.js");
        mocks.observedIdentities.push(getGatewayToolCallerIdentity());
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  ],
}));

import { createOpenClawTools } from "./openclaw-tools.js";

function requireTool(name: string, overrides?: Parameters<typeof createOpenClawTools>[0]) {
  const tool = createOpenClawTools({
    agentSessionKey: "agent:main:discord:channel:123",
    disableMessageTool: true,
    pluginToolAllowlist: [name],
    requesterAgentIdOverride: "main",
    wrapBeforeToolCallHook: false,
    ...overrides,
  }).find((candidate) => candidate.name === name);
  if (!tool?.execute) {
    throw new Error(`Expected executable tool ${name}`);
  }
  return tool;
}

describe("createOpenClawTools Gateway caller identity", () => {
  it("wraps plugin tools so direct cron Gateway calls inherit the agent identity", async () => {
    mocks.observedIdentities.length = 0;

    const tool = requireTool("synthetic_direct_cron_plugin");
    await tool.execute("tool-call-1", {});

    expect(mocks.observedIdentities).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:123",
      },
    ]);
  });

  it("carries trusted turn-source routing with the agent identity", async () => {
    mocks.observedIdentities.length = 0;

    const tool = requireTool("synthetic_direct_cron_plugin", {
      agentChannel: "discord",
      agentTo: "channel:123",
      agentAccountId: "work",
      agentThreadId: "thread-7",
    });
    await tool.execute("tool-call-2", {});

    expect(mocks.observedIdentities).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:123",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:123",
        turnSourceAccountId: "work",
        turnSourceThreadId: "thread-7",
      },
    ]);
  });

  it("uses scheduled creator account authority without changing live delivery routing", async () => {
    mocks.observedIdentities.length = 0;

    const tool = requireTool("synthetic_direct_cron_plugin", {
      agentChannel: "discord",
      agentTo: "channel:123",
      agentAccountId: "delivery-account",
      gatewayCallerAccountId: "creator-account",
    });
    await tool.execute("tool-call-scheduled", {});

    expect(mocks.observedIdentities).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:123",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:123",
        turnSourceAccountId: "creator-account",
      },
    ]);
  });
});

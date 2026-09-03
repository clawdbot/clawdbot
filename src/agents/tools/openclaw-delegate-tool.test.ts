import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";
import { createOpenClawDelegateToolsForRun } from "./openclaw-delegate-tool.js";

vi.mock("./in-process-gateway.js", () => ({
  callInProcessGatewayTool: vi.fn(),
}));

const callGateway = vi.mocked(callInProcessGatewayTool);

beforeEach(() => {
  callGateway.mockReset();
});

describe("openclaw delegation tool", () => {
  it("relays context and surfaces pending approval", async () => {
    callGateway.mockResolvedValue({
      sessionId: "ignored-by-client",
      reply: "Approval pending.",
      action: "none",
      needsApproval: true,
      proposalId: "system-agent:proposal-1",
    });
    const tool = createOpenClawDelegateToolsForRun({
      sessionAgentId: "main",
      runSessionKey: "agent:main:dm:one",
      agentChannel: "webchat",
      execSession: { permissionMode: "guarded" },
    })[0];
    if (!tool) {
      throw new Error("expected OpenClaw delegation tool");
    }
    expect(tool.description).toContain("Gateway restart");
    expect(tool.description).toContain("human approval");

    const result = await tool.execute("call-1", { message: "Add channel." });

    expect(callGateway).toHaveBeenCalledWith("openclaw.chat", {
      sessionId: expect.stringMatching(/^delegate-[a-f0-9]{32}$/),
      message: "Add channel.",
      delegation: {
        agentId: "main",
        sessionKey: "agent:main:dm:one",
        turnSourceChannel: "webchat",
      },
    });
    expect(result.details).toEqual({
      reply: "Approval pending.",
      needsApproval: true,
      proposalId: "system-agent:proposal-1",
    });
    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ reply: string; action?: string; needsApproval?: true; proposalId?: string }",
    );
    expect(tool.catalogMode).toBeUndefined();
  });

  it.each([
    { name: "default full", options: {}, full: true },
    {
      name: "explicit full overrides configured prompting",
      options: {
        execSession: { permissionMode: "full" },
        config: { tools: { exec: { mode: "ask" } } },
      },
      full: true,
    },
    { name: "guarded", options: { execSession: { permissionMode: "guarded" } }, full: false },
    { name: "workspace", options: { execSession: { permissionMode: "workspace" } }, full: false },
    {
      name: "restricted default",
      options: { config: { tools: { exec: { mode: "ask" } } } },
      full: false,
    },
    {
      name: "agent-restricted default",
      options: { config: { agents: { list: [{ id: "main", tools: { exec: { mode: "ask" } } }] } } },
      full: false,
    },
    {
      name: "turn-tightened full",
      options: { execSession: { permissionMode: "full" }, execOverrides: { ask: "always" } },
      full: false,
    },
    { name: "filesystem-restricted", options: { fsPolicy: { workspaceOnly: true } }, full: false },
  ] satisfies Array<{
    name: string;
    options: Omit<Parameters<typeof createOpenClawDelegateToolsForRun>[0], "sessionAgentId">;
    full: boolean;
  }>)("carries $name authority privately, not in RPC data", async ({ options, full }) => {
    callGateway.mockImplementation(async () => {
      expect(getGatewayToolCallerIdentity()?.fullPermission).toBe(full);
      return { sessionId: "delegate", reply: "Done." };
    });
    const [tool] = createOpenClawDelegateToolsForRun({
      sessionAgentId: "main",
      runSessionKey: "agent:main:main",
      ...options,
    });
    if (!tool) {
      throw new Error("expected OpenClaw delegation tool");
    }

    await tool.execute("call-policy", { message: "Change logging.", fullPermission: !full });

    expect(tool.description).toContain(full ? "without asking for approval" : "human approval");
    expect(callGateway.mock.calls[0]?.[1]).not.toHaveProperty("fullPermission");
    expect(callGateway.mock.calls[0]?.[1].delegation).not.toHaveProperty("fullPermission");
    expect(getGatewayToolCallerIdentity()).toBeUndefined();
  });

  it("reuses one session and accepts explicit continuation", async () => {
    callGateway.mockImplementation(async (_method: string, params: Record<string, unknown>) => ({
      sessionId: params.sessionId,
      reply: "Done.",
    }));
    const tool = createOpenClawDelegateToolsForRun({
      sessionAgentId: "main",
      runSessionKey: "agent:main:main",
    })[0];
    if (!tool) {
      throw new Error("expected OpenClaw delegation tool");
    }

    await tool.execute("call-1", { message: "First." });
    await tool.execute("call-2", { message: "Second." });
    await tool.execute("call-3", { message: "Other.", sessionId: "delegate-user-choice" });

    expect(callGateway.mock.calls[0]?.[1]).toMatchObject({
      sessionId: callGateway.mock.calls[1]?.[1].sessionId,
    });
    expect(callGateway.mock.calls[2]?.[1]).toMatchObject({ sessionId: "delegate-user-choice" });
  });

  it("uses the owner-only core gate", () => {
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("openclaw");
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { resolveToolsMcpAgentId, resolveToolsMcpSessionContext } from "./agent-session-env.js";
import { resolveOpenClawToolsForMcp } from "./openclaw-tools-serve.js";
const { callGatewayTool } = vi.hoisted(() => ({ callGatewayTool: vi.fn() }));
vi.mock("../config/config.js", async (original) => ({
  ...(await original<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => ({ agents: { ownership: "explicit", entries: { main: {}, work: {} } } }),
}));
vi.mock("../agents/tools/gateway.js", async (original) => ({
  ...(await original<typeof import("../agents/tools/gateway.js")>()),
  callGatewayTool,
}));
afterEach(() => {
  vi.clearAllMocks();
});

it("carries the private argv owner and exact logical key into the real automations tool", async () => {
  const agentId = resolveToolsMcpAgentId(["--openclaw-agent-id", "work"]);
  expect(resolveToolsMcpSessionContext({ agentId, agentSessionKey: "global" })).toEqual({
    agentId: "work",
    sessionKey: "global",
  });
  const [tool] = resolveOpenClawToolsForMcp({ agentId, agentSessionKey: "global" });
  callGatewayTool.mockImplementationOnce(async () => {
    expect(getGatewayToolCallerIdentity()).toMatchObject({
      agentId: "work",
      sessionKey: "global",
    });
    return { enabled: true };
  });
  await tool!.execute("owner-proof", { action: "status" });
  expect(callGatewayTool).toHaveBeenCalledOnce();
  expect(() =>
    resolveOpenClawToolsForMcp({ agentId: "main", agentSessionKey: "agent:work:main" }),
  ).toThrow("matching explicit");
});

it("rejects missing or duplicate private argv owners", () => {
  expect(() => resolveToolsMcpAgentId(["--openclaw-agent-id"])).toThrow("requires one");
  expect(() =>
    resolveToolsMcpAgentId(["--openclaw-agent-id", "work", "--openclaw-agent-id", "main"]),
  ).toThrow("requires one");
});

import { afterEach, expect, it, vi } from "vitest";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  resolveToolsMcpAgentId,
  resolveToolsMcpModelRef,
  resolveToolsMcpSessionContext,
} from "./agent-session-env.js";
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

it.each([
  {
    label: "agent owner",
    option: "--openclaw-agent-id",
    resolve: resolveToolsMcpAgentId,
    value: "work",
  },
  {
    label: "model ref",
    option: "--openclaw-model-ref",
    resolve: resolveToolsMcpModelRef,
    value: "openai/gpt-5.6",
  },
])(
  "reads one private $label argv value and rejects missing or duplicate values",
  ({ resolve, option, value }) => {
    expect(resolve([option, value])).toBe(value);
    expect(() => resolve([option])).toThrow("requires one");
    expect(() => resolve([option, value, option, value])).toThrow("requires one");
  },
);

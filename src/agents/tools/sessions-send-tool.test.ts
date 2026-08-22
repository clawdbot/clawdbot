import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { hashToolCall } from "../tool-loop-detection.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

function makeConfig(opts?: { agentToAgentEnabled?: boolean }): OpenClawConfig {
  return {
    agents: { entries: { main: {}, peer: {} } },
    tools: {
      agentToAgent: { enabled: opts?.agentToAgentEnabled ?? false },
    },
  } as unknown as OpenClawConfig;
}

type GatewayCall = {
  method: string;
  params?: unknown;
  timeoutMs?: number | null;
};

type RealGatewayCaller = typeof import("../../gateway/call.js").callGateway;

function makeTool(opts?: {
  gatewayKey?: string;
  gatewayError?: unknown;
  sandboxed?: boolean;
  agentToAgentEnabled?: boolean;
}) {
  const calls: GatewayCall[] = [];
  const callGateway = vi.fn(async (call: GatewayCall) => {
    calls.push(call);
    if (opts?.gatewayError) {
      throw opts.gatewayError;
    }
    return { key: opts?.gatewayKey ?? "" };
  });
  const tool = createSessionsSendTool({
    agentSessionKey: "agent:main:main",
    sandboxed: opts?.sandboxed,
    config: makeConfig({ agentToAgentEnabled: opts?.agentToAgentEnabled }),
    callGateway: callGateway as unknown as RealGatewayCaller,
  });
  return { tool, calls };
}

async function prepare(
  tool: ReturnType<typeof createSessionsSendTool>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prepareFn = tool.prepareBeforeToolCallParams;
  expect(prepareFn).toBeTypeOf("function");
  const result = (await prepareFn?.(args, {
    toolCallId: "call-1",
    hookContext: { sessionKey: "agent:main:main" },
  } as never)) as Record<string, unknown>;
  return result;
}

describe("sessions_send selector canonicalization before loop admission", () => {
  it("passes sessionKey-form calls through untouched", async () => {
    const { tool, calls } = makeTool();
    const result = await prepare(tool, {
      sessionKey: "agent:peer:main",
      message: "hello",
    });
    expect(result).toEqual({ sessionKey: "agent:peer:main", message: "hello" });
    expect(calls).toEqual([]);
  });

  it("canonicalizes agentId-form calls to the agent main session key", async () => {
    const { tool, calls } = makeTool();
    const result = await prepare(tool, { agentId: "peer", message: "hello" });
    expect(result).toEqual({ sessionKey: "agent:peer:main", message: "hello" });
    expect(calls).toEqual([]);
  });

  it("canonicalizes label-form calls via gateway sessions.resolve", async () => {
    const { tool, calls } = makeTool({ gatewayKey: "agent:peer:main" });
    const result = await prepare(tool, { label: "peer-main", message: "hello" });
    expect(result).toEqual({ sessionKey: "agent:peer:main", message: "hello" });
    expect(calls).toEqual([
      { method: "sessions.resolve", params: { label: "peer-main" }, timeoutMs: 10_000 },
    ]);
  });

  it("leaves unknown agentId calls untouched so execute reports the same error", async () => {
    const { tool, calls } = makeTool();
    const result = await prepare(tool, { agentId: "ghost", message: "hello" });
    expect(result).toEqual({ agentId: "ghost", message: "hello" });
    expect(calls).toEqual([]);
  });

  it("leaves unresolvable label calls untouched on gateway failure", async () => {
    const { tool, calls } = makeTool({ gatewayError: new Error("gateway down") });
    const result = await prepare(tool, { label: "peer-main", message: "hello" });
    expect(result).toEqual({ label: "peer-main", message: "hello" });
    expect(calls).toHaveLength(1);
  });

  it("leaves label calls untouched when the gateway resolves to no key", async () => {
    const { tool } = makeTool({ gatewayKey: "" });
    const result = await prepare(tool, { label: "peer-main", message: "hello" });
    expect(result).toEqual({ label: "peer-main", message: "hello" });
  });

  it("does not canonicalize cross-agent label sends when agent-to-agent messaging is disabled", async () => {
    const { tool, calls } = makeTool({
      gatewayKey: "agent:peer:main",
      agentToAgentEnabled: false,
    });
    const result = await prepare(tool, {
      label: "peer-main",
      agentId: "peer",
      message: "hello",
    });
    expect(result).toEqual({ label: "peer-main", agentId: "peer", message: "hello" });
    expect(calls).toEqual([]);
  });

  it("does not canonicalize cross-agent label sends from sandboxed sessions", async () => {
    const { tool, calls } = makeTool({
      gatewayKey: "agent:peer:main",
      sandboxed: true,
      agentToAgentEnabled: true,
    });
    const result = await prepare(tool, {
      label: "peer-main",
      agentId: "peer",
      message: "hello",
    });
    expect(result).toEqual({ label: "peer-main", agentId: "peer", message: "hello" });
    expect(calls).toEqual([]);
  });

  it("gives equivalent selector forms one loop-detection hash across reworded bodies", async () => {
    const { tool } = makeTool({ gatewayKey: "agent:peer:main" });
    const bySessionKey = await prepare(tool, {
      sessionKey: "agent:peer:main",
      message: "first rewording",
    });
    const byLabel = await prepare(tool, {
      label: "peer-main",
      message: "second rewording",
    });
    const byAgentId = await prepare(tool, {
      agentId: "peer",
      message: "third rewording",
    });
    const hashByKey = hashToolCall("sessions_send", bySessionKey);
    expect(hashToolCall("sessions_send", byLabel)).toBe(hashByKey);
    expect(hashToolCall("sessions_send", byAgentId)).toBe(hashByKey);
  });

  it("keeps sends to different targets hash-distinct after canonicalization", async () => {
    const { tool } = makeTool({ gatewayKey: "agent:peer:main" });
    const toPeer = await prepare(tool, { agentId: "peer", message: "hello" });
    const toMain = await prepare(tool, {
      sessionKey: "agent:main:other",
      message: "hello",
    });
    expect(hashToolCall("sessions_send", toPeer)).not.toBe(hashToolCall("sessions_send", toMain));
  });
});

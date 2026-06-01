import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

type ThinkingLevel = "high" | "medium" | "low" | "off";

function expectResolvedThinkingPlan(input: {
  expected: ThinkingLevel;
  expectedOverride?: ThinkingLevel | null;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  cfg?: OpenClawConfig;
}) {
  const cfg =
    input.cfg ??
    ({
      session: { mainKey: "main", scope: "per-sender" },
      agents: { defaults: { subagents: { thinking: "high" } } },
    } as OpenClawConfig);

  const plan = resolveSubagentThinkingOverride({
    cfg,
    requesterAgentConfig: input.requesterAgentConfig,
    targetAgentConfig: input.targetAgentConfig,
    thinkingOverrideRaw: input.thinkingOverrideRaw,
    callerThinkingRaw: input.callerThinkingRaw,
  });

  expect(plan).toEqual({
    status: "ok",
    thinkingOverride:
      input.expectedOverride === null ? undefined : (input.expectedOverride ?? input.expected),
    initialSessionPatch: { thinkingLevel: input.expected },
  });
}

describe("sessions_spawn thinking defaults", () => {
  it("applies agents.defaults.subagents.thinking when thinking is omitted", () => {
    expectResolvedThinkingPlan({
      expected: "high",
    });
  });

  it("prefers explicit sessions_spawn.thinking over config default", () => {
    expectResolvedThinkingPlan({
      thinkingOverrideRaw: "low",
      expected: "low",
    });
  });

  it("prefers per-agent subagent thinking over global subagent thinking", () => {
    expectResolvedThinkingPlan({
      targetAgentConfig: { subagents: { thinking: "medium" } },
      expected: "medium",
    });
  });

  it("prefers requester-agent subagent thinking over target-agent subagent thinking", () => {
    expectResolvedThinkingPlan({
      requesterAgentConfig: { subagents: { thinking: "low" } },
      targetAgentConfig: { subagents: { thinking: "medium" } },
      callerThinkingRaw: "high",
      expected: "low",
    });
  });

  it("inherits caller thinking when no explicit or configured subagent thinking exists", () => {
    expectResolvedThinkingPlan({
      cfg: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: {} },
      } as OpenClawConfig,
      callerThinkingRaw: "medium",
      expected: "medium",
      expectedOverride: null,
    });
  });

  it("prefers global subagent thinking over caller thinking", () => {
    expectResolvedThinkingPlan({
      callerThinkingRaw: "medium",
      expected: "high",
    });
  });

  it("preserves caller thinking off when inherited", () => {
    expectResolvedThinkingPlan({
      cfg: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: {} },
      } as OpenClawConfig,
      callerThinkingRaw: "off",
      expected: "off",
      expectedOverride: null,
    });
  });

  it("preserves explicit thinking off", () => {
    expectResolvedThinkingPlan({
      thinkingOverrideRaw: "off",
      expected: "off",
    });
  });

  it("preserves configured subagent thinking off", () => {
    expectResolvedThinkingPlan({
      targetAgentConfig: { subagents: { thinking: "off" } },
      callerThinkingRaw: "high",
      expected: "off",
    });
  });
});

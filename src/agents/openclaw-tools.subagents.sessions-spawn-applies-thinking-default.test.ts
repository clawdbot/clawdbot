import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

type ThinkingLevel = "high" | "medium" | "low";

function resolveThinkingPlan(input: { expected: ThinkingLevel; thinkingOverrideRaw?: string }) {
  const cfg = {
    session: { mainKey: "main", scope: "per-sender" },
    agents: { defaults: { subagents: { thinking: "high" } } },
  } as OpenClawConfig;

  const plan = resolveSubagentThinkingOverride({
    cfg,
    thinkingOverrideRaw: input.thinkingOverrideRaw,
  });

  expect(plan.status).toBe("ok");
  expect(plan).toMatchObject({
    thinkingOverride: input.expected,
    initialSessionPatch: { thinkingLevel: input.expected },
  });
}

describe("sessions_spawn thinking defaults", () => {
  it("applies agents.defaults.subagents.thinking when thinking is omitted", () => {
    resolveThinkingPlan({
      expected: "high",
    });
  });

  it("prefers explicit sessions_spawn.thinking over config default", () => {
    resolveThinkingPlan({
      thinkingOverrideRaw: "low",
      expected: "low",
    });
  });
});

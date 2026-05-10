import { describe, expect, it } from "vitest";
import {
  resolveSubagentAllowedTargetIds,
  resolveSubagentTargetPolicy,
} from "./subagent-target-policy.js";

describe("subagent target policy", () => {
  it("defaults to requester-only when no allowlist is configured", () => {
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "main",
        targetAgentId: "main",
        requestedAgentId: "main",
      }),
    ).toEqual({ ok: true });
    const result = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "other",
      requestedAgentId: "other",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected target policy to reject other agent");
    }
    expect(result.allowedText).toBe("main");
  });

  it("keeps omitted agentId self-spawns allowed even when an allowlist is configured", () => {
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "task-manager",
        targetAgentId: "task-manager",
        allowAgents: ["planner"],
      }),
    ).toEqual({ ok: true });
  });

  it("rejects explicit self-targets when the configured allowlist excludes the requester", () => {
    const result = resolveSubagentTargetPolicy({
      requesterAgentId: "task-manager",
      targetAgentId: "task-manager",
      requestedAgentId: "task-manager",
      allowAgents: ["planner", "checker"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected target policy to reject explicit self-target");
    }
    expect(result.allowedText).toBe("checker, planner");
    expect(result.error).toBe(
      "agentId is not allowed for sessions_spawn (allowed: checker, planner)",
    );
  });

  it("resolves allowed target ids without auto-adding requester for explicit allowlists", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["planner"],
        configuredAgentIds: ["main", "planner"],
      }),
    ).toEqual({
      allowAny: false,
      allowedIds: ["planner"],
    });
  });
});

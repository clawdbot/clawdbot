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
      configuredAgentIds: ["task-manager", "planner", "checker"],
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

  it("filters explicit allowlists to configured target ids", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["planner", "stale"],
        configuredAgentIds: ["main", "planner"],
      }),
    ).toEqual({
      allowAny: false,
      allowedIds: ["planner"],
    });

    const result = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "stale",
      requestedAgentId: "stale",
      allowAgents: ["planner", "stale"],
      configuredAgentIds: ["main", "planner"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected target policy to reject stale explicit target");
    }
    expect(result.allowedText).toBe("planner");
    expect(result.error).toBe(
      'agentId "stale" is not in the configured agent registry (allowed: planner)',
    );
  });

  it("limits wildcard allowlists to configured agents plus the requester", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["*"],
        configuredAgentIds: ["planner", "checker"],
      }),
    ).toEqual({
      allowAny: true,
      allowedIds: ["checker", "main", "planner"],
    });
  });

  it("rejects wildcard targets outside the configured registry", () => {
    const result = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "bogus",
      requestedAgentId: "bogus",
      allowAgents: ["*"],
      configuredAgentIds: ["main", "planner"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected target policy to reject unconfigured wildcard target");
    }
    expect(result.allowedText).toBe("main, planner");
    expect(result.error).toBe(
      'agentId "bogus" is not in the configured agent registry (allowed: main, planner)',
    );
  });

  it("filters explicit targets when wildcard allowlists are mixed", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["*", "beta"],
        configuredAgentIds: ["main", "planner"],
      }),
    ).toEqual({
      allowAny: true,
      allowedIds: ["main", "planner"],
    });

    const result = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "beta",
      requestedAgentId: "beta",
      allowAgents: ["*", "beta"],
      configuredAgentIds: ["main", "planner"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected target policy to reject stale mixed explicit target");
    }
    expect(result.error).toBe(
      'agentId "beta" is not in the configured agent registry (allowed: main, planner)',
    );
  });
});

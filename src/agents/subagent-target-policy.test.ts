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
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "main",
        targetAgentId: "other",
        requestedAgentId: "other",
      }),
    ).toMatchObject({ ok: false, allowedText: "main" });
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
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "task-manager",
        targetAgentId: "task-manager",
        requestedAgentId: "task-manager",
        allowAgents: ["planner", "checker"],
      }),
    ).toMatchObject({
      ok: false,
      allowedText: "checker, planner",
      error: "agentId is not allowed for sessions_spawn (allowed: checker, planner)",
    });
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

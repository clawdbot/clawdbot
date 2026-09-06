import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  discoverPersistedActiveGoalTargets,
  resolveGoalDriverConfig,
} from "./service.js";

describe("goal driver service", () => {
  it("is default-off and resolves only deterministic bounded settings", () => {
    expect(resolveGoalDriverConfig({})).toEqual({
      enabled: false,
      idleDelayMs: 20_000,
      maxContinuationTurns: 3,
    });
    expect(
      resolveGoalDriverConfig({
        tools: {
          experimental: {
            goalDriver: {
              enabled: true,
              idleDelayMs: 7_500,
              maxContinuationTurns: 5,
            },
          },
        },
      }),
    ).toEqual({
      enabled: true,
      idleDelayMs: 7_500,
      maxContinuationTurns: 5,
    });
  });

  it("recovers active goals from every agent store and refuses bare global keys", () => {
    const config: OpenClawConfig = {
      agents: { list: [{ id: "alpha" }, { id: "beta" }] },
    };
    const resolveStoreTargets = vi.fn(() => [
      { agentId: "alpha", storePath: "/state/agents/alpha/sessions/sessions.json" },
      { agentId: "beta", storePath: "/state/agents/beta/sessions/sessions.json" },
    ]);
    const listEntries = vi.fn(({ storePath }: { storePath: string }) => {
      const agentId = storePath.includes("/alpha/") ? "alpha" : "beta";
      return [
        {
          sessionKey: `agent:${agentId}:main`,
          entry: {
            sessionId: `${agentId}-session`,
            updatedAt: 1,
            goal: {
              schemaVersion: 1 as const,
              id: `${agentId}-goal`,
              objective: `Finish ${agentId}`,
              status: "active" as const,
              createdAt: 1,
              updatedAt: 1,
              tokenStart: 0,
              tokenStartFresh: true,
              tokensUsed: 0,
              continuationTurns: 0,
            },
          },
        },
        {
          sessionKey: `agent:${agentId}:paused`,
          entry: {
            sessionId: `${agentId}-paused`,
            updatedAt: 1,
            goal: {
              schemaVersion: 1 as const,
              id: `${agentId}-paused-goal`,
              objective: "Do not rearm",
              status: "paused" as const,
              createdAt: 1,
              updatedAt: 1,
              tokenStart: 0,
              tokenStartFresh: true,
              tokensUsed: 0,
              continuationTurns: 0,
            },
          },
        },
        {
          // Both stores intentionally contain this key. Current-main system-event
          // queues cannot distinguish the owner, so the safe behavior is refusal.
          sessionKey: "global",
          entry: {
            sessionId: `${agentId}-global`,
            updatedAt: 1,
            goal: {
              schemaVersion: 1 as const,
              id: `${agentId}-global-goal`,
              objective: "Must not cross agent stores",
              status: "active" as const,
              createdAt: 1,
              updatedAt: 1,
              tokenStart: 0,
              tokenStartFresh: true,
              tokensUsed: 0,
              continuationTurns: 0,
            },
          },
        },
      ];
    });

    const targets = discoverPersistedActiveGoalTargets(config, {
      resolveStoreTargets,
      listEntries,
    });

    expect(targets).toEqual([
      {
        agentId: "alpha",
        sessionKey: "agent:alpha:main",
        storePath: "/state/agents/alpha/sessions/sessions.json",
      },
      {
        agentId: "beta",
        sessionKey: "agent:beta:main",
        storePath: "/state/agents/beta/sessions/sessions.json",
      },
    ]);
    expect(resolveStoreTargets).toHaveBeenCalledWith(config);
    expect(listEntries).toHaveBeenCalledTimes(2);
  });
});

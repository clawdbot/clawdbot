import { describe, expect, it } from "vitest";
import { classifySessionAttention } from "./diagnostic-session-attention.js";

describe("classifySessionAttention", () => {
  it.each([
    {
      name: "stale state without queued work",
      queueDepth: 0,
      activity: {},
      expected: {
        eventType: "session.stuck",
        reason: "stale_session_state",
        classification: "stale_session_state",
        recoveryEligible: true,
      },
    },
    {
      name: "queued stale state without active work",
      queueDepth: 1,
      activity: {},
      expected: {
        eventType: "session.stuck",
        reason: "queued_work_without_active_run",
        classification: "stale_session_state",
        recoveryEligible: true,
      },
    },
    {
      name: "active embedded run making progress",
      queueDepth: 0,
      activity: {
        activeWorkKind: "embedded_run" as const,
        lastProgressAgeMs: 10_000,
      },
      expected: {
        eventType: "session.long_running",
        reason: "active_work",
        classification: "long_running",
        activeWorkKind: "embedded_run",
        recoveryEligible: false,
      },
    },
    {
      name: "queued behind active work",
      queueDepth: 1,
      activity: {
        activeWorkKind: "embedded_run" as const,
        lastProgressAgeMs: 10_000,
      },
      expected: {
        eventType: "session.long_running",
        reason: "queued_behind_active_work",
        classification: "long_running",
        activeWorkKind: "embedded_run",
        recoveryEligible: false,
      },
    },
    {
      name: "active work without progress",
      queueDepth: 0,
      activity: {
        activeWorkKind: "model_call" as const,
        lastProgressAgeMs: 31_000,
      },
      expected: {
        eventType: "session.stalled",
        reason: "active_work_without_progress",
        classification: "stalled_agent_run",
        activeWorkKind: "model_call",
        recoveryEligible: false,
      },
    },
    {
      name: "blocked tool call",
      queueDepth: 0,
      activity: {
        activeWorkKind: "tool_call" as const,
        activeToolAgeMs: 31_000,
        lastProgressAgeMs: 31_000,
      },
      expected: {
        eventType: "session.stalled",
        reason: "blocked_tool_call",
        classification: "blocked_tool_call",
        activeWorkKind: "tool_call",
        recoveryEligible: false,
      },
    },
  ])("$name", ({ activity, expected, queueDepth }) => {
    expect(
      classifySessionAttention({
        queueDepth,
        activity,
        staleMs: 30_000,
      }),
    ).toEqual(expected);
  });
});

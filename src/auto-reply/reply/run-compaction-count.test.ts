import { describe, expect, it } from "vitest";
import type { EmbeddedAgentRunMeta } from "../../agents/embedded-agent-runner/types.js";
import { resolveOperationalRunCompactionCount } from "./run-compaction-count.js";

function createMeta(overrides: Partial<EmbeddedAgentRunMeta>): EmbeddedAgentRunMeta {
  return {
    durationMs: 1,
    ...overrides,
  };
}

function createAgentMeta(compactionCount: number) {
  return {
    sessionId: "session",
    provider: "openai",
    model: "gpt-5.6-luna",
    compactionCount,
  };
}

describe("resolveOperationalRunCompactionCount", () => {
  it("prefers current-turn context metadata over diagnostic metadata", () => {
    expect(
      resolveOperationalRunCompactionCount(
        createMeta({
          agentMeta: createAgentMeta(7),
          contextManagement: { lastTurnCompactions: 1 },
        }),
      ),
    ).toBe(1);
  });

  it("does not use diagnostic metadata for a completed run", () => {
    expect(
      resolveOperationalRunCompactionCount(
        createMeta({
          agentMeta: createAgentMeta(7),
        }),
      ),
    ).toBe(0);
  });

  it.each([
    {
      name: "incomplete turn",
      meta: createMeta({
        agentMeta: createAgentMeta(2),
        error: { kind: "incomplete_turn", message: "incomplete" },
      }),
    },
    {
      name: "timeout",
      meta: createMeta({
        agentMeta: createAgentMeta(2),
        timeoutPhase: "provider",
      }),
    },
  ])("uses diagnostic metadata for a $name without context metadata", ({ meta }) => {
    expect(resolveOperationalRunCompactionCount(meta)).toBe(2);
  });

  it("rejects invalid metadata counts", () => {
    expect(
      resolveOperationalRunCompactionCount(
        createMeta({
          agentMeta: createAgentMeta(Number.NaN),
          error: { kind: "incomplete_turn", message: "incomplete" },
        }),
      ),
    ).toBe(0);
  });
});

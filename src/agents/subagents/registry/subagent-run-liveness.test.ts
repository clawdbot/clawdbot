// Subagent run liveness tests cover stale-unended detection and child-link
// retention windows for registry list/read paths.
import { describe, expect, it, vi } from "vitest";
import {
  isLiveUnendedSubagentRun,
  RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
  isStaleUnendedSubagentRun,
  shouldKeepSubagentRunChildLink,
} from "./subagent-run-liveness.js";

const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;

describe("subagent run liveness", () => {
  const now = Date.parse("2026-04-25T12:00:00Z");

  it("keeps fresh unended runs live", () => {
    const entry = {
      createdAt: now - 60_000,
      execution: {},
    };
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(true);
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
  });

  it("marks old unended runs stale when no explicit timeout extends the window", () => {
    const entry = {
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      execution: {},
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(true);
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(false);
  });

  it("does not mark ended runs stale", () => {
    const entry = {
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      execution: { endedAt: now - 1 },
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(false);
  });

  it("uses sessionStartedAt ahead of createdAt", () => {
    const entry = {
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      sessionStartedAt: now - 60_000,
      execution: {},
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("extends stale cutoff for explicit long run timeouts", () => {
    const entry = {
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      runTimeoutSeconds: 6 * 60 * 60,
      execution: {},
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("ignores non-real fixture timestamps as unknown instead of stale", () => {
    // Small fixture timestamps appear in tests and old synthetic records; they
    // should not be interpreted as Unix epoch production runs.
    const entry = {
      createdAt: 100,
      execution: {},
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("defaults to current time when now is omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      expect(
        isStaleUnendedSubagentRun({
          createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
          execution: {},
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps child links only while live, recently ended, or waiting on descendants", () => {
    expect(
      shouldKeepSubagentRunChildLink({ createdAt: now - 60_000, execution: {} }, { now }),
    ).toBe(true);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          createdAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 60_000,
          execution: { endedAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS + 1 },
        },
        { now },
      ),
    ).toBe(true);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          createdAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 60_000,
          execution: { endedAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 1 },
        },
        { now },
      ),
    ).toBe(false);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          createdAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 60_000,
          execution: { endedAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 1 },
        },
        { activeDescendants: 1, now },
      ),
    ).toBe(true);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
          execution: {},
        },
        { now },
      ),
    ).toBe(false);
  });

  it("keeps the child link when cleanup finished without dispatching a delete", () => {
    const endedAt = now - 60_000;
    // Delete runs whose session effects were suppressed still get a completion
    // stamp, but their child session was never handed to sessions.delete and is
    // still navigable. Reading completion alone would hide a live session.
    const entry = {
      createdAt: now - 120_000,
      execution: { endedAt },
      cleanup: "delete" as const,
      cleanupCompletedAt: endedAt + 1_000,
    };
    expect(shouldKeepSubagentRunChildLink(entry, { now })).toBe(true);
  });

  it("drops child links once delete cleanup dispatched sessions.delete", () => {
    const endedAt = now - 60_000;
    // The dispatch stamp is durable before the gateway call and the completion
    // stamp only after it, so a run interrupted in between must not relink.
    const entry = {
      createdAt: now - 120_000,
      execution: { endedAt },
      cleanup: "delete" as const,
      deleteCleanupDispatchedAt: endedAt + 1_000,
    };
    expect(shouldKeepSubagentRunChildLink(entry, { now })).toBe(false);
    expect(shouldKeepSubagentRunChildLink(entry, { activeDescendants: 1, now })).toBe(false);
  });

  it("keeps the child link while delete cleanup has not been dispatched", () => {
    expect(
      shouldKeepSubagentRunChildLink(
        {
          createdAt: now - 120_000,
          execution: { endedAt: now - 60_000 },
          cleanup: "delete" as const,
        },
        { now },
      ),
    ).toBe(true);
  });
});

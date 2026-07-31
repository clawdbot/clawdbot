import { describe, expect, it } from "vitest";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { resolveSidebarSessionSubtitle } from "./session-row-subtitle.ts";

function workSession(): SidebarRecentSession {
  return {
    attention: { kind: "none" },
    hasActiveRun: false,
    label: "Backing session",
    status: "done",
    subtitle: "~/Projects/openclaw",
    workSession: true,
  } as unknown as SidebarRecentSession;
}

describe("resolveSidebarSessionSubtitle", () => {
  it("does not fall back to a backing work subtitle when catalog display omits one", () => {
    expect(
      resolveSidebarSessionSubtitle({
        session: workSession(),
        hasDisplay: true,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        narrationLine: undefined,
      }),
    ).toEqual({ subtitle: undefined, narration: undefined });
  });

  it("uses attention, agent status, observer, narration, then work subtitle precedence", () => {
    const session: SidebarRecentSession = {
      ...workSession(),
      hasActiveRun: true,
      activeRunIds: ["run-1"],
      status: "running",
      agentStatusNote: "Waiting for deployment",
      attention: { kind: "question" },
    };
    const observerDigest = {
      runId: "run-1",
      headline: "Running checks",
      health: "on-track" as const,
      updatedAt: 2_000,
      revision: 1,
    };
    const resolve = (overrides: Partial<SidebarRecentSession> = {}) =>
      resolveSidebarSessionSubtitle({
        session: { ...session, ...overrides },
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        narrationLine: "Using test runner",
        observerDigest,
      });

    expect(resolve().subtitle).toBe("Waiting for your answer");
    expect(resolve({ attention: { kind: "none" } }).subtitle).toBe("Waiting for deployment");
    expect(resolve({ attention: { kind: "none" }, agentStatusNote: undefined }).subtitle).toBe(
      "Running checks",
    );
    expect(
      resolveSidebarSessionSubtitle({
        session: {
          ...session,
          attention: { kind: "none" },
          agentStatusNote: undefined,
          observerDigest: undefined,
        },
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        narrationLine: "Using test runner",
        observerDigest: null,
      }),
    ).toEqual({ subtitle: "Using test runner", narration: "Using test runner" });
  });

  it("suppresses missing and stale projected digests for an active run", () => {
    const session: SidebarRecentSession = {
      ...workSession(),
      hasActiveRun: true,
      activeRunIds: ["run-2"],
      status: "running",
    };
    const resolve = (runId: string | undefined) =>
      resolveSidebarSessionSubtitle({
        session,
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        narrationLine: "Using test runner",
        observerDigest: {
          runId,
          headline: "Old digest",
          health: "on-track",
          updatedAt: 2_000,
          revision: 1,
        },
      });

    expect(resolve(undefined)).toEqual({
      subtitle: "Using test runner",
      narration: "Using test runner",
    });
    expect(resolve("run-1")).toEqual({
      subtitle: "Using test runner",
      narration: "Using test runner",
    });
    expect(resolve("run-2")).toEqual({ subtitle: "Old digest", narration: undefined });
  });

  it("shows an unread idle final digest until the row is read", () => {
    const observerDigest = {
      headline: "Finished with warnings",
      health: "done" as const,
      updatedAt: 2_000,
      revision: 2,
    };
    const session = { ...workSession(), observerDigest, lastReadAt: 1_999 };
    const resolve = (lastReadAt: number) =>
      resolveSidebarSessionSubtitle({
        session: { ...session, lastReadAt },
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        narrationLine: undefined,
        observerDigest: null,
      });

    expect(resolve(1_999).subtitle).toBe("Finished with warnings");
    expect(resolve(2_000).subtitle).toBe("~/Projects/openclaw");
  });
});

describe("observer digest freshness reconciliation", () => {
  it("prefers the higher-revision digest regardless of source", async () => {
    const { pickFreshestObserverDigest } = await import("../lib/observer-digest.ts");
    const older = { revision: 4, updatedAt: 100, headline: "old" };
    const newer = { revision: 5, updatedAt: 50, headline: "new" };
    expect(pickFreshestObserverDigest(older, newer)?.headline).toBe("new");
    expect(pickFreshestObserverDigest(newer, older)?.headline).toBe("new");
    expect(pickFreshestObserverDigest(null, older)?.headline).toBe("old");
    expect(pickFreshestObserverDigest(older, null)?.headline).toBe("old");
    const tie = { revision: 5, updatedAt: 60, headline: "tie-newer" };
    expect(pickFreshestObserverDigest(newer, tie)?.headline).toBe("tie-newer");
  });
});

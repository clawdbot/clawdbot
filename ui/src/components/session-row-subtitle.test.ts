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
        showPreview: true,
        narrationLine: undefined,
      }),
    ).toEqual({ subtitle: undefined, narration: undefined });
  });

  it("ignores live narration when a stale running status has no projected active run", () => {
    expect(
      resolveSidebarSessionSubtitle({
        session: { ...workSession(), status: "running" },
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        showPreview: true,
        narrationLine: "Still running",
      }),
    ).toEqual({ subtitle: "~/Projects/openclaw", narration: undefined });
  });

  it("does not replace the work subtitle for queued sessions", () => {
    expect(
      resolveSidebarSessionSubtitle({
        session: { ...workSession(), hasActiveRun: true, status: "queued" },
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        showPreview: true,
        narrationLine: undefined,
      }),
    ).toEqual({ subtitle: "~/Projects/openclaw", narration: undefined });
  });

  it.each(["stuck", "waiting-on-user"] as const)(
    "keeps a %s observer headline when previews are hidden",
    (health) => {
      // isCriticalObserverHealth owns these two states; the chat pane announces them
      // too, so a display preference must not silence them in the sidebar.
      expect(
        resolveSidebarSessionSubtitle({
          session: {
            ...workSession(),
            hasActiveRun: true,
            activeRunIds: ["run-1"],
            status: "running",
          },
          hasDisplay: false,
          displaySubtitle: undefined,
          sidebarLiveActivity: true,
          showPreview: false,
          narrationLine: "Using bash",
          observerDigest: {
            runId: "run-1",
            headline: "Blocked on a missing credential",
            health,
            updatedAt: 2_000,
            revision: 1,
          },
        }),
      ).toEqual({ subtitle: "Blocked on a missing credential", narration: undefined });
    },
  );

  it("still hides a non-critical observer headline when previews are hidden", () => {
    expect(
      resolveSidebarSessionSubtitle({
        session: {
          ...workSession(),
          hasActiveRun: true,
          activeRunIds: ["run-1"],
          status: "running",
        },
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        showPreview: false,
        narrationLine: undefined,
        observerDigest: {
          runId: "run-1",
          headline: "Running checks",
          health: "on-track",
          updatedAt: 2_000,
          revision: 1,
        },
      }),
    ).toEqual({ subtitle: undefined, narration: undefined });
  });

  it("does not force a queued subtitle when previews are hidden", () => {
    expect(
      resolveSidebarSessionSubtitle({
        session: { ...workSession(), hasActiveRun: true, status: "queued" },
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        showPreview: false,
        narrationLine: undefined,
      }),
    ).toEqual({ subtitle: undefined, narration: undefined });
  });

  it("leaves the subtitle empty while question attention is in the leading glyph", () => {
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
        showPreview: true,
        narrationLine: "Using test runner",
        observerDigest,
      });

    expect(resolve()).toEqual({ subtitle: undefined, narration: undefined });
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
        showPreview: true,
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
        showPreview: true,
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

  it("prefers an unread idle final digest over the last reply", () => {
    const observerDigest = {
      headline: "Finished with warnings",
      health: "done" as const,
      updatedAt: 2_000,
      revision: 2,
    };
    expect(
      resolveSidebarSessionSubtitle({
        session: {
          ...workSession(),
          lastMessagePreview: "The final reply is durable.",
          observerDigest,
          lastReadAt: 1_999,
        },
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        showPreview: true,
        narrationLine: undefined,
        observerDigest: null,
      }).subtitle,
    ).toBe("Finished with warnings");
  });

  it("falls back to the last reply after the idle final digest is read", () => {
    expect(
      resolveSidebarSessionSubtitle({
        session: {
          ...workSession(),
          lastMessagePreview: "The final reply is durable.",
          observerDigest: {
            headline: "Finished with warnings",
            health: "done",
            updatedAt: 2_000,
            revision: 2,
          },
          lastReadAt: 2_000,
        },
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        showPreview: true,
        narrationLine: undefined,
        observerDigest: null,
      }).subtitle,
    ).toBe("The final reply is durable.");
  });

  it("keeps subtitle-owned attention and agent status ahead of the idle digest and last reply", () => {
    const session = {
      ...workSession(),
      lastMessagePreview: "The final reply is durable.",
      lastReadAt: 1_999,
      observerDigest: {
        headline: "Still implementing the repair",
        health: "done" as const,
        updatedAt: 2_000,
        revision: 2,
      },
    };
    const resolve = (overrides: Partial<SidebarRecentSession>) =>
      resolveSidebarSessionSubtitle({
        session: { ...session, ...overrides },
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        showPreview: true,
        narrationLine: undefined,
        observerDigest: null,
      }).subtitle;

    expect(resolve({ agentStatusNote: "Waiting for deployment" })).toBe("Waiting for deployment");
    expect(
      resolve({ attention: { kind: "question" }, agentStatusNote: "Waiting for deployment" }),
    ).toBeUndefined();
    expect(
      resolve({
        attention: { kind: "approval" },
        agentStatusNote: "Waiting for deployment",
      }),
    ).toBe("Waiting for approval");
  });

  it("does not let a prior last-message preview displace running activity", () => {
    const session = {
      ...workSession(),
      hasActiveRun: true,
      activeRunIds: ["run-1"],
      lastMessagePreview: "Reply from the previous run",
    };

    expect(
      resolveSidebarSessionSubtitle({
        session,
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        showPreview: true,
        narrationLine: "Running the focused tests",
        observerDigest: {
          runId: "run-1",
          headline: "Implementing the repair",
          health: "on-track",
          updatedAt: 2_000,
          revision: 1,
        },
      }).subtitle,
    ).toBe("Implementing the repair");
  });

  it("keeps attention visible while hiding every preview candidate", () => {
    const hidden = (session: SidebarRecentSession, narrationLine?: string) =>
      resolveSidebarSessionSubtitle({
        session,
        hasDisplay: false,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        showPreview: false,
        narrationLine,
        observerDigest: session.observerDigest ?? null,
      }).subtitle;

    expect(
      hidden({
        ...workSession(),
        attention: { kind: "error", reason: "⚠️ ✉️ Message failed: deployment unavailable" },
        agentStatusNote: "Waiting for deployment",
        lastMessagePreview: "The final reply is durable.",
      }),
    ).toBe("Run failed:   Message failed: deployment unavailable");

    expect([
      hidden({ ...workSession(), agentStatusNote: "Waiting for deployment" }),
      hidden({ ...workSession(), hasActiveRun: true }, "Using test runner"),
      hidden({
        ...workSession(),
        observerDigest: {
          headline: "Running checks",
          health: "done",
          updatedAt: 2_000,
          revision: 1,
        },
      }),
      hidden({ ...workSession(), lastMessagePreview: "The final reply is durable." }),
      hidden(workSession()),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
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

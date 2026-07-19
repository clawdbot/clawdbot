import { describe, expect, it, vi } from "vitest";
import { MeetingSessionRuntime, type MeetingSessionRuntimeJoinContext } from "./session-runtime.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingSessionRecord,
} from "./session-types.js";

type TestTransport = "chrome";
type TestMode = "agent";
type TestRequest = { url: string; agentId: string };
type TestSession = MeetingSessionRecord<TestTransport, TestMode> & {
  browser?: {
    launched: boolean;
    tab?: MeetingBrowserTab;
    health?: MeetingBrowserHealth;
    hasAudioBridge?: boolean;
  };
};
type TestJoinContext = MeetingSessionRuntimeJoinContext<
  TestSession,
  TestTransport,
  TestMode,
  MeetingBrowserHealth,
  MeetingBrowserTab
>;

function createTestRuntime(params: {
  talkBack?: boolean;
  refreshReusableSession?(
    session: TestSession,
    request: TestRequest,
    resolved: { agentId: string; mode: TestMode; transport: TestTransport; url: string },
  ): Promise<{ keepBrowserTab: boolean } | void>;
  joinTransport(input: {
    request: TestRequest;
    session: TestSession;
    context: TestJoinContext;
  }): Promise<{ delegatedSpoken?: boolean }>;
  releaseBrowserTab(session: TestSession): Promise<boolean | undefined>;
}) {
  let nextSessionId = 0;
  const createdSessions: TestSession[] = [];
  const runtime = new MeetingSessionRuntime<
    TestSession,
    TestRequest,
    TestTransport,
    TestMode,
    MeetingBrowserHealth,
    MeetingBrowserTab,
    string,
    string
  >({
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    logScope: "[meeting-test]",
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    messages: {
      previousBrowserLeaveFailed: "previous leave failed",
      reassignedSessionNote: "reassigned",
      reusedSessionNote: "reused",
      replacementBrowserLeaveFailed: "replacement leave failed",
      speechBlockedFallback: "speech blocked",
      speech: {
        audioBridgeUnavailable: "bridge unavailable",
        browserUnverified: "browser unverified",
        manualActionFallback: "manual action",
        microphoneMuted: "microphone muted",
        microphoneMutedReason: "microphone-muted",
        notInCall: "not in call",
        notInCallReason: "not-in-call",
        browserUnverifiedReason: "browser-unverified",
        audioBridgeUnavailableReason: "bridge-unavailable",
      },
    },
    reuseExistingBrowserTab: true,
    waitForInCallMs: 1,
    joinTimeoutMs: 1,
    transientSpeechBlockedReasons: new Set<string>(),
    resolveJoin: (request) => ({
      url: request.url,
      transport: "chrome",
      mode: "agent",
      agentId: request.agentId,
    }),
    createSession: ({ resolved, createdAt }) => {
      const session: TestSession = {
        id: `session-${++nextSessionId}`,
        ...resolved,
        state: "active",
        createdAt,
        updatedAt: createdAt,
        participantIdentity: "OpenClaw",
        realtime: { enabled: false, toolPolicy: "none" },
        notes: [],
      };
      createdSessions.push(session);
      return session;
    },
    resolveSpeechInstructions: () => undefined,
    isBrowserTransport: () => true,
    isTalkBackMode: () => params.talkBack === true,
    isTranscribeMode: () => false,
    sameMeetingUrl: (left, right) => left === right,
    normalizeMeetingUrlForReuse: (url) => url,
    getBrowser: (session) =>
      session.browser
        ? {
            launched: session.browser.launched,
            tab: session.browser.tab,
            health: session.browser.health,
            hasAudioBridge: session.browser.hasAudioBridge === true,
          }
        : undefined,
    setBrowserTab: (session, tab) => {
      if (session.browser) {
        session.browser.tab = tab;
      }
    },
    setBrowserHealth: (session, health) => {
      if (session.browser) {
        session.browser.health = health;
      }
    },
    joinTransport: (input) => params.joinTransport(input),
    releaseBrowserTab: (session) => params.releaseBrowserTab(session),
    refreshBrowserHealth: async () => {},
    refreshStatus: async () => {},
    refreshReusableSession: async (session, request, resolved) =>
      await params.refreshReusableSession?.(session, request, resolved),
    ensureRealtimeBridge: async () => undefined,
    captureTranscript: async () => undefined,
    speakViaTransport: async () => undefined,
  });
  return { createdSessions, runtime };
}

describe("MeetingSessionRuntime failed joins", () => {
  it("cleans an externally ended reusable session before replacing it", async () => {
    const stop = vi.fn(async () => {});
    const releaseBrowserTab = vi.fn(async () => true);
    const joinTransport = vi.fn(
      async ({ session, context }: { session: TestSession; context: TestJoinContext }) => {
        session.browser = {
          launched: true,
          tab: { targetId: session.id, openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    );
    const { runtime } = createTestRuntime({
      joinTransport,
      refreshReusableSession: async (session) => {
        session.state = "ended";
      },
      releaseBrowserTab,
    });
    const first = await runtime.join({ url: "https://meeting.example/room", agentId: "main" });

    const replacement = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).not.toHaveBeenCalled();
    expect(joinTransport).toHaveBeenCalledTimes(2);
  });

  it("stops attached transport handles and releases the partial browser tab", async () => {
    const joinError = new Error("transport setup failed");
    const stop = vi.fn(async () => {});
    let releaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (releaseAttempts++ === 0) {
        return false;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "partial-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        throw joinError;
      },
    });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(joinError);

    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
    expect(createdSessions[0]).toMatchObject({ state: "ended", browser: { tab: undefined } });
    expect(runtime.list()).toEqual([]);
  });

  it("retries transport cleanup for an unpublished failed join", async () => {
    const joinError = new Error("transport setup failed");
    const stopError = new Error("transport stop failed");
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "partial-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        throw joinError;
      },
    });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(joinError);

    expect(stop).toHaveBeenCalledTimes(2);
    expect(releaseBrowserTab).toHaveBeenCalledOnce();
    expect(runtime.list()).toEqual([]);
  });

  it("retries unprocessed retained tabs after settlement rejects", async () => {
    const settlementError = new Error("retained release rejected");
    const oldStop = vi.fn(async () => {});
    const replacementStop = vi.fn(async () => {});
    const releaseOrder: string[] = [];
    let oldReleaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      releaseOrder.push(session.id);
      if (session.id === "session-1" && oldReleaseAttempts++ === 0) {
        throw settlementError;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        const first = session.id === "session-1";
        session.browser = {
          launched: true,
          tab: {
            targetId: first ? "retained-tab" : "replacement-tab",
            openedByPlugin: true,
          },
        };
        context.attachRuntimeHandles(session, { stop: first ? oldStop : replacementStop });
        return {};
      },
    });
    await runtime.join({ url: "https://meeting.example/room", agentId: "support" });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(settlementError);

    expect(oldStop).toHaveBeenCalledOnce();
    expect(replacementStop).toHaveBeenCalledOnce();
    expect(releaseOrder).toEqual(["session-1", "session-2", "session-1"]);
    expect(createdSessions[0]?.browser?.tab).toBeUndefined();
    expect(createdSessions[1]).toMatchObject({ state: "ended", browser: { tab: undefined } });
  });

  it("retries retained cleanup when stopping the previous session rejects", async () => {
    const stopError = new Error("previous transport stop failed");
    const settlementError = new Error("retained release rejected");
    const oldStop = vi.fn(async () => {
      throw stopError;
    });
    let releaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (releaseAttempts++ === 0) {
        throw settlementError;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const joinTransport = vi.fn(
      async ({ session, context }: { session: TestSession; context: TestJoinContext }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "retained-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop: oldStop });
        return {};
      },
    );
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport,
    });
    await runtime.join({ url: "https://meeting.example/room", agentId: "support" });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(stopError);

    expect(joinTransport).toHaveBeenCalledOnce();
    expect(oldStop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
    expect(createdSessions[0]).toMatchObject({ state: "ended", browser: { tab: undefined } });
  });
});

describe("MeetingSessionRuntime leave cleanup", () => {
  it("clears stale in-call health after confirmed browser departure", async () => {
    const { runtime } = createTestRuntime({
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          health: {
            inCall: true,
            micMuted: false,
            manualActionMessage: "old action",
            manualActionReason: "old-action",
            manualActionRequired: true,
            speechReady: true,
            speechBlockedMessage: "old speech block",
            speechBlockedReason: "old-speech-block",
          },
          tab: { targetId: "leave-tab", openedByPlugin: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      browserLeft: true,
      session: {
        browser: {
          health: {
            inCall: false,
            manualActionRequired: false,
            speechReady: false,
          },
        },
      },
    });
    expect(session.browser?.health?.manualActionReason).toBeUndefined();
    expect(session.browser?.health?.manualActionMessage).toBeUndefined();
    expect(session.browser?.health?.micMuted).toBeUndefined();
    expect(session.browser?.health?.speechBlockedReason).toBeUndefined();
    expect(session.browser?.health?.speechBlockedMessage).toBeUndefined();
  });

  it("retries a failed transport stop without repeating settled browser cleanup", async () => {
    const stopError = new Error("transport stop failed");
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "leave-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).rejects.toBe(stopError);
    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: true,
    });

    expect(stop).toHaveBeenCalledTimes(2);
    expect(releaseBrowserTab).toHaveBeenCalledOnce();
  });

  it("retries browser cleanup that reported an unsuccessful leave", async () => {
    const stop = vi.fn(async () => {});
    const releaseBrowserTab = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "retry-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: false,
    });
    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: true,
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
  });
});

describe("MeetingSessionRuntime speech readiness", () => {
  it("treats an unknown microphone state as transiently unverified", async () => {
    const { runtime } = createTestRuntime({
      talkBack: true,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          hasAudioBridge: true,
          health: { inCall: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    expect(runtime.refreshSpeechReadiness(session)).toEqual({
      ready: false,
      reason: "browser-unverified",
      message: "browser unverified",
    });
    expect(session.browser?.health).toMatchObject({
      speechReady: false,
      speechBlockedReason: "browser-unverified",
    });

    session.browser!.health = { ...session.browser?.health, micMuted: false };
    expect(runtime.refreshSpeechReadiness(session)).toEqual({ ready: true });
  });
});

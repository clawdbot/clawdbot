import { describe, expect, it } from "vitest";
import { openMeetingWithBrowser, recoverMeetingBrowserTab } from "./browser-controller.js";
import { isMeetingBrowserTransientNavigationError } from "./browser-navigation-errors.js";

describe("meeting browser navigation errors", () => {
  it.each([
    "page.evaluate: Execution context was destroyed, most likely because of a navigation.",
    "Protocol error: Cannot find context with specified id",
  ])("retries expected navigation races: %s", (message) => {
    expect(isMeetingBrowserTransientNavigationError(new Error(message))).toBe(true);
  });

  it("does not retry unrelated browser-control failures", () => {
    expect(isMeetingBrowserTransientNavigationError(new Error("browser unavailable"))).toBe(false);
  });
});

describe("meeting browser join readiness", () => {
  it("retries a platform-owned transient in-call status", async () => {
    const adoptionAttempts: boolean[] = [];
    const captionCaptureAttempts: boolean[] = [];
    let evaluationAttempts = 0;
    const result = await openMeetingWithBrowser({
      adapter: {
        browserLabel: "Test meeting",
        urls: {
          accountHint: () => undefined,
          buildJoinUrl: (session) => session.url,
          isPreferredJoinUrl: () => true,
          isRecoverableTab: () => true,
          isSameMeeting: () => true,
          localeAction: () => undefined,
          normalizeForReuse: () => "test-meeting",
          validateAndNormalize: (input) => String(input),
        },
        browser: {
          allowsMicrophone: () => true,
          browserControlUnavailable: () => ({
            category: "browser-control-unavailable",
            reason: "browser-unavailable",
            message: "Browser unavailable.",
          }),
          buildLeaveScript: () => "",
          buildStatusJoinScript: (params) => {
            adoptionAttempts.push(params.allowSessionAdoption);
            captionCaptureAttempts.push(params.captureCaptions);
            return "() => '{}'";
          },
          captions: {
            buildTranscriptScript: () => "",
            enabled: () => true,
            parseTranscript: () => ({ droppedLines: 0, lines: [] }),
          },
          classifyManualAction: (health) =>
            health.manualActionRequired
              ? { category: "audio-choice-required", reason: "audio-choice", message: "Wait." }
              : undefined,
          parseLeaveResult: () => ({ departed: false }),
          parseStatus: () =>
            evaluationAttempts === 1
              ? {
                  inCall: true,
                  manualActionRequired: true,
                  manualActionReason: "audio-choice",
                  micMuted: false,
                }
              : { inCall: true, manualActionRequired: false, micMuted: false },
          permissions: () => undefined,
          permissionNotes: () => [],
          shouldRetryJoinStatus: (health) => health.manualActionReason === "audio-choice",
        },
      },
      callBrowser: async (request) => {
        if (request.path === "/tabs") {
          return { tabs: [{ targetId: "target-1", url: "https://meet.test/meeting" }] };
        }
        if (request.path === "/act") {
          evaluationAttempts += 1;
        }
        return {};
      },
      config: {
        launch: true,
        reuseExistingTab: true,
        autoJoin: true,
        guestName: "OpenClaw QA",
        joinTimeoutMs: 1_000,
        waitForInCallMs: 1_000,
      },
      session: {
        captureCaptions: false,
        meetingSessionId: "session-1",
        mode: "agent",
        url: "https://meet.test/meeting",
      },
    });

    expect(evaluationAttempts).toBe(2);
    expect(adoptionAttempts).toEqual([true, false]);
    expect(captionCaptureAttempts).toEqual([false, false]);
    expect(result.browser).toMatchObject({
      inCall: true,
      manualActionRequired: false,
      micMuted: false,
    });
  });
});

describe("meeting browser recovery", () => {
  it("retries status inspection when auto-join navigation destroys the page context", async () => {
    const adoptionAttempts: boolean[] = [];
    let evaluationAttempts = 0;
    const evaluationTimeouts: number[] = [];
    const result = await recoverMeetingBrowserTab({
      adapter: {
        browserLabel: "Test meeting",
        urls: {
          accountHint: () => undefined,
          buildJoinUrl: (session) => session.url,
          isPreferredJoinUrl: () => true,
          isRecoverableTab: () => true,
          isSameMeeting: () => true,
          localeAction: () => undefined,
          normalizeForReuse: () => "test-meeting",
          validateAndNormalize: (input) => String(input),
        },
        browser: {
          allowsMicrophone: () => false,
          browserControlUnavailable: () => ({
            category: "browser-control-unavailable",
            reason: "browser-unavailable",
            message: "Browser unavailable.",
          }),
          buildLeaveScript: () => "",
          buildStatusJoinScript: (params) => {
            adoptionAttempts.push(params.allowSessionAdoption);
            return "() => '{}'";
          },
          captions: {
            buildTranscriptScript: () => "",
            enabled: () => false,
            parseTranscript: () => ({ droppedLines: 0, lines: [] }),
          },
          classifyManualAction: () => undefined,
          parseLeaveResult: () => ({ departed: false }),
          parseStatus: () => ({ status: "browser-control", inCall: true }),
          permissions: () => undefined,
          permissionNotes: () => [],
        },
      },
      allowSessionAdoption: true,
      autoJoin: true,
      callBrowser: async (request) => {
        if (request.path === "/tabs") {
          return { tabs: [{ targetId: "target-1", url: "https://meet.test/meeting" }] };
        }
        if (request.path === "/act") {
          evaluationAttempts += 1;
          evaluationTimeouts.push(request.timeoutMs);
          if (evaluationAttempts === 1) {
            throw new Error("page.evaluate: Execution context was destroyed because of navigation");
          }
        }
        return {};
      },
      config: {
        launch: true,
        reuseExistingTab: true,
        autoJoin: true,
        guestName: "OpenClaw QA",
        joinTimeoutMs: 2_000,
        waitForInCallMs: 2_000,
      },
      locationLabel: "for testing",
      meetingSessionId: "session-1",
      mode: "listen",
      requestedMeetingUrl: "https://meet.test/meeting",
      timeoutMs: 500,
      trackedMeetingUrl: "https://meet.test/meeting",
      trackedTargetId: "target-1",
    });

    expect(evaluationAttempts).toBe(2);
    expect(adoptionAttempts).toEqual([true, false]);
    expect(evaluationTimeouts[0]).toBeLessThanOrEqual(500);
    expect(evaluationTimeouts[1]).toBeLessThan(evaluationTimeouts[0] ?? 0);
    expect(result.browser).toMatchObject({
      inCall: true,
      notes: ["Test meeting navigated while recovering; retrying browser inspection."],
    });
  });
});

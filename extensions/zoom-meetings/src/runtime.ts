import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsConfig, ZoomMeetingsMode, ZoomMeetingsTransport } from "./config.js";
import { testZoomMeetingListening, testZoomMeetingSpeech } from "./runtime-probes.js";
import { getZoomMeetingsSetupStatus } from "./runtime-setup.js";
import {
  launchZoomMeetingInChrome,
  launchZoomMeetingOnNode,
  leaveZoomMeetingInBrowser,
  readZoomMeetingTranscript,
  recoverCurrentZoomMeetingTab,
} from "./transports/chrome.js";
import type { ZoomMeetingsChromeHealth } from "./transports/types.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./transports/zoom-meetings-platform-adapter.js";
import { hasSameZoomMeetingJoinCredential } from "./transports/zoom-meetings-urls.js";

export const ZoomMeetingsRuntime = MeetingPlatformAdapter.createRuntimeFacade<
  ZoomMeetingsConfig,
  ZoomMeetingsTransport,
  ZoomMeetingsMode,
  ZoomMeetingsChromeHealth,
  {
    setup: Awaited<ReturnType<typeof getZoomMeetingsSetupStatus>>;
    listening: Awaited<ReturnType<typeof testZoomMeetingListening>>;
    speech: Awaited<ReturnType<typeof testZoomMeetingSpeech>>;
  }
>({
  platform: ZOOM_MEETINGS_PLATFORM_ADAPTER,
  transport: {
    launchInChrome: launchZoomMeetingInChrome,
    launchOnNode: launchZoomMeetingOnNode,
    leaveInBrowser: leaveZoomMeetingInBrowser,
    readTranscript: readZoomMeetingTranscript,
    recoverCurrentTab: recoverCurrentZoomMeetingTab,
  },
  probes: {
    setupStatus: getZoomMeetingsSetupStatus,
    testListening: testZoomMeetingListening,
    testSpeech: testZoomMeetingSpeech,
  },
  hooks: {
    // Normalize before locking so credential reuse sees the exact launched request.
    normalizeJoinRequest: (request, context) => {
      const resolved = context.resolvedJoin(request);
      return { ...request, agentId: resolved.agentId, url: resolved.url };
    },
    // Stateful admission refresh lets the admitted page adopt its existing session.
    isAwaitingAdmission: (session) =>
      session.chrome?.health?.lobbyWaiting === true ||
      session.chrome?.health?.manualAction?.reason === "zoom-admission-required",
    // Only Zoom treats a missing or host-ended page as terminal during status.
    afterStatusRefresh: async (session, context) => {
      const confirmedTabMissing = session.chrome?.health?.status === "browser-tab-missing";
      if (session.state === "active" && confirmedTabMissing) {
        session.browserLeft = true;
        await context.endSession(session.id, { keepBrowserTab: true });
      } else if (session.state === "active" && session.chrome?.health?.meetingEnded === true) {
        await context.endSession(session.id);
      }
    },
    // Corrected passcodes replace pending joins; safe stale sessions retain their tab.
    refreshReusableSession: async (session, request, context) => {
      await context.refreshBrowserHealth(session, { force: true, readOnly: false });
      const browser = session.chrome;
      const health = browser?.health;
      const staleSession =
        !browser?.browserTab ||
        health?.meetingEnded === true ||
        health?.manualAction?.reason === "zoom-session-conflict" ||
        health?.manualAction?.reason === "browser-control-unavailable" ||
        health?.bridgeClosed === true;
      const replacePendingJoin =
        health?.inCall !== true &&
        health?.manualAction?.reason === "zoom-passcode-required" &&
        !hasSameZoomMeetingJoinCredential(session.url, request.url);
      if (!staleSession && !replacePendingJoin) {
        return undefined;
      }
      session.state = "ended";
      session.updatedAt = new Date().toISOString();
      context.noteSession(
        session,
        replacePendingJoin
          ? "Ended pending Zoom session after receiving a corrected meeting credential."
          : "Ended stale Zoom session before opening a replacement.",
      );
      context.deleteRequesterSessionKey(session.id);
      return {
        keepBrowserTab:
          !replacePendingJoin && health?.meetingEnded !== true && health?.bridgeClosed !== true,
      };
    },
    // A closed Zoom realtime engine is absent so a later speak can rebuild it.
    isAudioBridgeActive: (session) =>
      Boolean(session.chrome?.audioBridge && session.chrome.health?.bridgeClosed !== true),
    afterAudioBridgeAttached: (session) => {
      if (session.chrome) {
        session.chrome.health = { ...session.chrome.health, bridgeClosed: false };
      }
    },
    validateLaunchResult: (result) => {
      if (result.browser?.meetingEnded === true) {
        throw new Error("The Zoom meeting has already ended.");
      }
    },
    // Missing or unreachable browser state is authoritative for Zoom session reuse;
    // recording it prevents a dead tab from being reported or reused as active.
    recordBrowserRecoveryFailure: (session, failure) => {
      if (!session.chrome) {
        return;
      }
      if (failure.kind === "missing") {
        session.chrome.browserTab = undefined;
        session.browserLeft = true;
      }
      session.chrome.health = {
        ...session.chrome.health,
        inCall: false,
        micMuted: undefined,
        captioning: false,
        audioInputRouted: false,
        audioOutputRouted: false,
        manualAction: { reason: "browser-control-unavailable", message: failure.message },
        status: failure.kind === "missing" ? "browser-tab-missing" : "browser-control",
        notes: [
          ...(session.chrome.health?.notes ?? []).filter((note) => note !== failure.message),
          failure.message,
        ],
      };
      session.updatedAt = new Date().toISOString();
    },
  },
  messages: {
    browserReadinessFailed: (error) => `Zoom browser readiness refresh failed: ${error}`,
    durableTranscripts: { providerId: "zoom", providerName: "Zoom" },
    joined: {
      local:
        "Zoom guest joined in local Chrome with realtime audio through the native virtual-audio backend.",
      node: "Zoom guest joined in Chrome on the selected node with realtime audio through the node bridge.",
      transcribe: "Zoom guest joined observe-only with live-caption transcript capture.",
      waiting:
        "Zoom guest join is waiting for the browser to become ready before starting realtime audio.",
    },
    leaveFailed: (error) => `Browser control could not leave the Zoom meeting tab: ${error}`,
    noTrackedTab:
      "No tracked Zoom meeting tab; leave the browser meeting manually if it is still active.",
    sharedTab: "Kept the shared Zoom meeting tab open for another active session.",
    sessionRuntime: {
      previousBrowserLeaveFailed:
        "Could not leave the previous Zoom meeting tab before reassignment.",
      reassignedSessionNote:
        "Ended before the same Zoom meeting tab was reassigned to another agent.",
      reusedSessionNote: "Reused existing active Zoom meeting session.",
      replacementBrowserLeaveFailed:
        "Could not leave the previous Zoom meeting tab before reassignment.",
      speechBlockedFallback: "Realtime speech blocked until Zoom is ready.",
      speech: {
        audioBridgeUnavailable: "Realtime speech requires an active Chrome audio bridge.",
        browserUnverified: "Zoom browser state has not been verified yet.",
        microphoneMuted: "Turn on the OpenClaw Zoom microphone before asking OpenClaw to speak.",
        microphoneMutedReason: "zoom-microphone-muted",
        notInCall: "Zoom has not reported that the browser guest is in the call.",
        notInCallReason: "not-in-call",
        browserUnverifiedReason: "browser-unverified",
        audioBridgeUnavailableReason: "audio-bridge-unavailable",
      },
    },
  },
});

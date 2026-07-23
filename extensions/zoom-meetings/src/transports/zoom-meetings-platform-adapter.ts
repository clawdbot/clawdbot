import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  MeetingBrowserJoinSession,
  MeetingManualActionCategory,
  MeetingPlatformAdapter,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsMode } from "../config.js";
import type { ZoomMeetingsChromeHealth, ZoomMeetingsTranscriptSnapshot } from "./types.js";
import {
  zoomMeetingLeaveScript,
  zoomMeetingStatusScript,
  zoomMeetingTranscriptScript,
} from "./zoom-meetings-page-scripts.js";
import { ZOOM_MEETINGS_NODE_COMMAND } from "./zoom-meetings-platform-constants.js";
import {
  isRecoverableZoomMeetingTab,
  isSameZoomMeetingUrl,
  normalizeZoomMeetingUrl,
  normalizeZoomMeetingUrlForReuse,
} from "./zoom-meetings-urls.js";

function zoomMeetingOrigin(meetingUrl: string): string | undefined {
  return normalizeZoomMeetingUrlForReuse(meetingUrl) ? "https://app.zoom.us" : undefined;
}

function parsePermissionGrantNotes(result: unknown): string[] {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const unsupportedPermissions = Array.isArray(record.unsupportedPermissions)
    ? record.unsupportedPermissions.filter((value): value is string => typeof value === "string")
    : [];
  const notes = ["Granted Zoom microphone permission through browser control."];
  if (unsupportedPermissions.includes("speakerSelection")) {
    notes.push("Chrome did not accept the optional Zoom speaker-selection permission.");
  }
  return notes;
}

export function isZoomMeetingsTalkBackMode(mode: ZoomMeetingsMode): boolean {
  return mode === "agent" || mode === "bidi";
}

export function isZoomMeetingsRealtimeRouteReady(
  mode: ZoomMeetingsMode,
  health: ZoomMeetingsChromeHealth | undefined,
): boolean {
  return (
    isZoomMeetingsTalkBackMode(mode) &&
    health?.inCall === true &&
    health.micMuted === false &&
    health.audioInputRouted === true &&
    health.audioOutputRouted === true &&
    health.manualActionRequired !== true
  );
}

function parseBrowserStatus(result: unknown): ZoomMeetingsChromeHealth | undefined {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (typeof record.result !== "string" || !record.result.trim()) {
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(record.result) as Record<string, unknown>;
  } catch {
    throw new Error("Zoom browser status JSON is malformed.");
  }
  return {
    inCall: typeof parsed.inCall === "boolean" ? parsed.inCall : undefined,
    meetingEnded: typeof parsed.meetingEnded === "boolean" ? parsed.meetingEnded : undefined,
    micMuted: typeof parsed.micMuted === "boolean" ? parsed.micMuted : undefined,
    cameraOff: typeof parsed.cameraOff === "boolean" ? parsed.cameraOff : undefined,
    lobbyWaiting: typeof parsed.lobbyWaiting === "boolean" ? parsed.lobbyWaiting : undefined,
    captionCaptureRequested:
      typeof parsed.captionCaptureRequested === "boolean"
        ? parsed.captionCaptureRequested
        : undefined,
    captioning: typeof parsed.captioning === "boolean" ? parsed.captioning : undefined,
    captionsEnabledAttempted:
      typeof parsed.captionsEnabledAttempted === "boolean"
        ? parsed.captionsEnabledAttempted
        : undefined,
    transcriptLines:
      typeof parsed.transcriptLines === "number" ? parsed.transcriptLines : undefined,
    lastCaptionAt: typeof parsed.lastCaptionAt === "string" ? parsed.lastCaptionAt : undefined,
    lastCaptionSpeaker:
      typeof parsed.lastCaptionSpeaker === "string" ? parsed.lastCaptionSpeaker : undefined,
    lastCaptionText:
      typeof parsed.lastCaptionText === "string" ? parsed.lastCaptionText : undefined,
    recentTranscript: Array.isArray(parsed.recentTranscript)
      ? parsed.recentTranscript.flatMap((value) => {
          if (!value || typeof value !== "object") {
            return [];
          }
          const line = value as { at?: unknown; speaker?: unknown; text?: unknown };
          if (typeof line.text !== "string" || !line.text.trim()) {
            return [];
          }
          return [
            {
              ...(typeof line.at === "string" ? { at: line.at } : {}),
              ...(typeof line.speaker === "string" ? { speaker: line.speaker } : {}),
              text: line.text,
            },
          ];
        })
      : undefined,
    audioInputRouted:
      typeof parsed.audioInputRouted === "boolean" ? parsed.audioInputRouted : undefined,
    audioInputDeviceLabel:
      typeof parsed.audioInputDeviceLabel === "string" ? parsed.audioInputDeviceLabel : undefined,
    audioInputRouteError:
      typeof parsed.audioInputRouteError === "string" ? parsed.audioInputRouteError : undefined,
    audioOutputRouted:
      typeof parsed.audioOutputRouted === "boolean" ? parsed.audioOutputRouted : undefined,
    audioOutputDeviceLabel:
      typeof parsed.audioOutputDeviceLabel === "string" ? parsed.audioOutputDeviceLabel : undefined,
    audioOutputRouteError:
      typeof parsed.audioOutputRouteError === "string" ? parsed.audioOutputRouteError : undefined,
    audioOutputRouteRetryable:
      typeof parsed.audioOutputRouteRetryable === "boolean"
        ? parsed.audioOutputRouteRetryable
        : undefined,
    manualActionRequired:
      typeof parsed.manualActionRequired === "boolean" ? parsed.manualActionRequired : undefined,
    manualActionReason:
      typeof parsed.manualActionReason === "string"
        ? (parsed.manualActionReason as ZoomMeetingsChromeHealth["manualActionReason"])
        : undefined,
    manualActionMessage:
      typeof parsed.manualActionMessage === "string" ? parsed.manualActionMessage : undefined,
    browserUrl: typeof parsed.url === "string" ? parsed.url : undefined,
    browserTitle: typeof parsed.title === "string" ? parsed.title : undefined,
    status: "browser-control",
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.filter((note): note is string => typeof note === "string")
      : undefined,
  };
}

function classifyManualAction(health: ZoomMeetingsChromeHealth) {
  if (!health.manualActionRequired || !health.manualActionReason || !health.manualActionMessage) {
    return undefined;
  }
  const category: MeetingManualActionCategory =
    health.manualActionReason === "zoom-login-required"
      ? "login-required"
      : health.manualActionReason === "zoom-admission-required"
        ? "admission-required"
        : health.manualActionReason === "zoom-passcode-required" ||
            health.manualActionReason === "zoom-captcha-required"
          ? "admission-required"
          : health.manualActionReason === "zoom-permission-required"
            ? "permission-required"
            : health.manualActionReason === "zoom-audio-choice-required"
              ? "audio-choice-required"
              : health.manualActionReason === "zoom-session-conflict"
                ? "session-conflict"
                : health.manualActionReason === "browser-control-unavailable"
                  ? "browser-control-unavailable"
                  : "custom";
  return {
    category,
    reason: health.manualActionReason,
    message: health.manualActionMessage,
  };
}

function parseLeaveResult(result: unknown): {
  departed: boolean;
  leaveAction?: "leave" | "confirm";
  sessionConflict?: boolean;
  sessionMatched?: boolean;
  urlMatched?: boolean;
} {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (typeof record.result !== "string" || !record.result.trim()) {
    return { departed: false };
  }
  try {
    const parsed = JSON.parse(record.result) as Record<string, unknown>;
    const leaveAction =
      parsed.leaveAction === "leave" || parsed.leaveAction === "confirm"
        ? parsed.leaveAction
        : undefined;
    return {
      departed: parsed.departed === true,
      ...(leaveAction ? { leaveAction } : {}),
      ...(typeof parsed.sessionConflict === "boolean"
        ? { sessionConflict: parsed.sessionConflict }
        : {}),
      ...(typeof parsed.sessionMatched === "boolean"
        ? { sessionMatched: parsed.sessionMatched }
        : {}),
      ...(typeof parsed.urlMatched === "boolean" ? { urlMatched: parsed.urlMatched } : {}),
    };
  } catch {
    return { departed: false };
  }
}

function parseTranscript(
  result: unknown,
): ZoomMeetingsTranscriptSnapshot & { sessionMatched?: boolean; urlMatched?: boolean } {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (typeof record.result !== "string" || !record.result.trim()) {
    return { droppedLines: 0, lines: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.result);
  } catch {
    throw new Error("Zoom transcript JSON is malformed.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Zoom transcript payload is invalid.");
  }
  const payload = parsed as {
    droppedLines?: unknown;
    epoch?: unknown;
    lines?: unknown;
    sessionMatched?: unknown;
    urlMatched?: unknown;
  };
  const droppedLines =
    typeof payload.droppedLines === "number" && Number.isSafeInteger(payload.droppedLines)
      ? Math.max(0, payload.droppedLines)
      : 0;
  const lines = Array.isArray(payload.lines)
    ? payload.lines.flatMap((value) => {
        if (!value || typeof value !== "object") {
          return [];
        }
        const line = value as { at?: unknown; speaker?: unknown; text?: unknown };
        if (typeof line.text !== "string" || !line.text.trim()) {
          return [];
        }
        return [
          {
            ...(typeof line.at === "string" ? { at: line.at } : {}),
            ...(typeof line.speaker === "string" ? { speaker: line.speaker } : {}),
            text: line.text,
          },
        ];
      })
    : [];
  return {
    droppedLines,
    ...(typeof payload.epoch === "string" ? { epoch: payload.epoch } : {}),
    lines,
    ...(typeof payload.urlMatched === "boolean" ? { urlMatched: payload.urlMatched } : {}),
    ...(typeof payload.sessionMatched === "boolean"
      ? { sessionMatched: payload.sessionMatched }
      : {}),
  };
}

export const ZOOM_MEETINGS_PLATFORM_ADAPTER = {
  id: "zoom-meetings",
  displayName: "Zoom meetings",
  browserLabel: "Zoom meeting",
  logScope: "[zoom-meetings]",
  agentConsult: {
    surface: "a private Zoom meeting",
    userLabel: "Participant",
    assistantLabel: "Agent",
    questionSourceLabel: "participant",
    workingResponseLabel: "participant",
    extraSystemPrompt: [
      "You are a behind-the-scenes consultant for a live meeting voice agent.",
      "Prioritize a fast, speakable answer over exhaustive investigation.",
      "Use only bounded, task-relevant tool calls.",
      "Never print secrets or dump environment variables.",
      "Be accurate, brief, and speakable.",
    ].join(" "),
  },
  session: {
    idPrefix: "zoom_meeting",
    participantIdentity: (transport) =>
      transport === "chrome-node"
        ? "Zoom guest in Chrome on a paired node"
        : "Zoom guest in the OpenClaw Chrome profile",
  },
  nodeCommandName: ZOOM_MEETINGS_NODE_COMMAND,
  nodeConfigPath: "plugins.entries.zoom-meetings.config.chromeNode.node",
  urls: {
    validateAndNormalize: normalizeZoomMeetingUrl,
    normalizeForReuse: normalizeZoomMeetingUrlForReuse,
    isSameMeeting: isSameZoomMeetingUrl,
    buildJoinUrl: (session) => session.url,
    accountHint: () => undefined,
    isPreferredJoinUrl: (url) => Boolean(normalizeZoomMeetingUrlForReuse(url)),
    isRecoverableTab: isRecoverableZoomMeetingTab,
    localeAction: () => undefined,
  },
  browser: {
    allowsMicrophone: isZoomMeetingsTalkBackMode,
    buildStatusJoinScript: (params) =>
      zoomMeetingStatusScript({
        allowMicrophone: isZoomMeetingsTalkBackMode(params.mode),
        allowSessionAdoption: params.allowSessionAdoption,
        autoJoin: params.autoJoin,
        captureCaptions: params.captureCaptions,
        guestName: params.guestName,
        meetingSessionId: params.meetingSessionId || undefined,
        meetingUrl: params.url,
        readOnly: params.readOnly,
        waitForInCallMs: params.waitForInCallMs,
      }),
    parseStatus: parseBrowserStatus,
    classifyManualAction,
    shouldRetryJoinStatus: (health) =>
      health.inCall === true &&
      ((health.manualActionReason === "zoom-audio-choice-required" &&
        health.audioInputRouted === true &&
        health.audioOutputRouteRetryable === true) ||
        (health.manualActionRequired !== true &&
          health.captionCaptureRequested === true &&
          health.captioning !== true)),
    browserControlUnavailable: () => ({
      category: "browser-control-unavailable",
      reason: "browser-control-unavailable",
      message:
        "Open the OpenClaw browser profile, finish the Zoom sign-in, admission, or permission prompt, then retry.",
    }),
    buildLeaveScript: (meetingUrl) =>
      zoomMeetingLeaveScript({
        leaveInitiated: false,
        meetingSessionId: "",
        meetingUrl,
      }),
    buildSessionLeaveScript: zoomMeetingLeaveScript,
    parseLeaveResult,
    captions: {
      enabled: (mode) => mode === "transcribe",
      buildTranscriptScript: ({ finalize, meetingSessionId, meetingUrl }) =>
        zoomMeetingTranscriptScript(meetingUrl, meetingSessionId, finalize),
      parseTranscript,
    },
    permissions: ({ allowMicrophone, meetingUrl }) => {
      const origin = zoomMeetingOrigin(meetingUrl);
      return allowMicrophone && origin
        ? {
            origin,
            permissions: ["audioCapture"],
            optionalPermissions: ["speakerSelection"],
          }
        : undefined;
    },
    permissionNotes: ({ allowMicrophone, error, result }) => {
      if (!allowMicrophone) {
        return ["Observe-only mode does not request Zoom microphone access."];
      }
      if (error) {
        return [
          `Could not grant Zoom media permissions automatically: ${formatErrorMessage(error)}`,
        ];
      }
      return parsePermissionGrantNotes(result);
    },
  },
} satisfies MeetingPlatformAdapter<
  MeetingBrowserJoinSession<ZoomMeetingsMode>,
  ZoomMeetingsMode,
  ZoomMeetingsChromeHealth,
  ZoomMeetingsTranscriptSnapshot
>;

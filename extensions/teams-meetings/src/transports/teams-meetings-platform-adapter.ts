import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  MeetingBrowserJoinSession,
  MeetingManualActionCategory,
  MeetingPlatformAdapter,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsMode } from "../config.js";
import {
  teamsMeetingLeaveScript,
  teamsMeetingStatusScript,
  teamsMeetingTranscriptScript,
} from "./teams-meetings-page-scripts.js";
import { TEAMS_MEETINGS_NODE_COMMAND } from "./teams-meetings-platform-constants.js";
import {
  isRecoverableTeamsMeetingTab,
  isSameTeamsMeetingUrl,
  normalizeTeamsMeetingUrl,
  normalizeTeamsMeetingUrlForReuse,
} from "./teams-meetings-urls.js";
import type { TeamsMeetingsChromeHealth, TeamsMeetingsTranscriptSnapshot } from "./types.js";

function teamsMeetingOrigin(meetingUrl: string): string | undefined {
  try {
    const origin = new URL(meetingUrl).origin;
    return origin === "https://teams.microsoft.com" || origin === "https://teams.live.com"
      ? origin
      : undefined;
  } catch {
    return undefined;
  }
}

function parsePermissionGrantNotes(result: unknown): string[] {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const unsupportedPermissions = Array.isArray(record.unsupportedPermissions)
    ? record.unsupportedPermissions.filter((value): value is string => typeof value === "string")
    : [];
  const notes = ["Granted Teams microphone permission through browser control."];
  if (unsupportedPermissions.includes("speakerSelection")) {
    notes.push("Chrome did not accept the optional Teams speaker-selection permission.");
  }
  return notes;
}

export function isTeamsMeetingsTalkBackMode(mode: TeamsMeetingsMode): boolean {
  return mode === "agent" || mode === "bidi";
}

export function isTeamsMeetingsRealtimeRouteReady(
  mode: TeamsMeetingsMode,
  health: TeamsMeetingsChromeHealth | undefined,
): boolean {
  return (
    isTeamsMeetingsTalkBackMode(mode) &&
    health?.inCall === true &&
    health.micMuted === false &&
    health.audioInputRouted === true &&
    health.audioOutputRouted === true &&
    health.manualActionRequired !== true
  );
}

function parseBrowserStatus(result: unknown): TeamsMeetingsChromeHealth | undefined {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (typeof record.result !== "string" || !record.result.trim()) {
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(record.result) as Record<string, unknown>;
  } catch {
    throw new Error("Microsoft Teams browser status JSON is malformed.");
  }
  return {
    inCall: typeof parsed.inCall === "boolean" ? parsed.inCall : undefined,
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
        ? (parsed.manualActionReason as TeamsMeetingsChromeHealth["manualActionReason"])
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

function classifyManualAction(health: TeamsMeetingsChromeHealth) {
  if (!health.manualActionRequired || !health.manualActionReason || !health.manualActionMessage) {
    return undefined;
  }
  const category: MeetingManualActionCategory =
    health.manualActionReason === "teams-login-required"
      ? "login-required"
      : health.manualActionReason === "teams-admission-required"
        ? "admission-required"
        : health.manualActionReason === "teams-permission-required"
          ? "permission-required"
          : health.manualActionReason === "teams-audio-choice-required"
            ? "audio-choice-required"
            : health.manualActionReason === "teams-session-conflict"
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
): TeamsMeetingsTranscriptSnapshot & { sessionMatched?: boolean; urlMatched?: boolean } {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (typeof record.result !== "string" || !record.result.trim()) {
    return { droppedLines: 0, lines: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.result);
  } catch {
    throw new Error("Microsoft Teams transcript JSON is malformed.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Microsoft Teams transcript payload is invalid.");
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

export const TEAMS_MEETINGS_PLATFORM_ADAPTER = {
  id: "teams-meetings",
  displayName: "Microsoft Teams meetings",
  browserLabel: "Teams meeting",
  logScope: "[teams-meetings]",
  agentConsult: {
    surface: "a private Microsoft Teams meeting",
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
    idPrefix: "teams_meeting",
    participantIdentity: (transport) =>
      transport === "chrome-node"
        ? "Microsoft Teams guest in Chrome on a paired node"
        : "Microsoft Teams guest in the OpenClaw Chrome profile",
  },
  nodeCommandName: TEAMS_MEETINGS_NODE_COMMAND,
  nodeConfigPath: "plugins.entries.teams-meetings.config.chromeNode.node",
  urls: {
    validateAndNormalize: normalizeTeamsMeetingUrl,
    normalizeForReuse: normalizeTeamsMeetingUrlForReuse,
    isSameMeeting: isSameTeamsMeetingUrl,
    buildJoinUrl: (session) => session.url,
    accountHint: () => undefined,
    isPreferredJoinUrl: (url) => Boolean(normalizeTeamsMeetingUrlForReuse(url)),
    isRecoverableTab: isRecoverableTeamsMeetingTab,
    localeAction: () => undefined,
  },
  browser: {
    allowsMicrophone: isTeamsMeetingsTalkBackMode,
    buildStatusJoinScript: (params) =>
      teamsMeetingStatusScript({
        allowMicrophone: isTeamsMeetingsTalkBackMode(params.mode),
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
      ((health.manualActionReason === "teams-audio-choice-required" &&
        health.audioInputRouted === true &&
        health.audioOutputRouteRetryable === true) ||
        (health.manualActionRequired !== true &&
          health.captionCaptureRequested === true &&
          health.captioning !== true)),
    browserControlUnavailable: () => ({
      category: "browser-control-unavailable",
      reason: "browser-control-unavailable",
      message:
        "Open the OpenClaw browser profile, finish the Teams sign-in, admission, or permission prompt, then retry.",
    }),
    buildLeaveScript: (meetingUrl) =>
      teamsMeetingLeaveScript({
        leaveInitiated: false,
        meetingSessionId: "",
        meetingUrl,
      }),
    buildSessionLeaveScript: teamsMeetingLeaveScript,
    parseLeaveResult,
    captions: {
      enabled: (mode) => mode === "transcribe",
      buildTranscriptScript: ({ finalize, meetingSessionId, meetingUrl }) =>
        teamsMeetingTranscriptScript(meetingUrl, meetingSessionId, finalize),
      parseTranscript,
    },
    permissions: ({ allowMicrophone, meetingUrl }) => {
      const origin = teamsMeetingOrigin(meetingUrl);
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
        return ["Observe-only mode does not request Teams microphone access."];
      }
      if (error) {
        return [
          `Could not grant Teams media permissions automatically: ${formatErrorMessage(error)}`,
        ];
      }
      return parsePermissionGrantNotes(result);
    },
  },
} satisfies MeetingPlatformAdapter<
  MeetingBrowserJoinSession<TeamsMeetingsMode>,
  TeamsMeetingsMode,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsTranscriptSnapshot
>;

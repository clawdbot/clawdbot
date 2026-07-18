// Google Meet adapter: platform URL, DOM, wire-value, and manual-action ownership.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  MeetingBrowserJoinSession,
  MeetingManualActionCategory,
  MeetingPlatformAdapter,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig, GoogleMeetMode } from "../config.js";
import { normalizeMeetUrl } from "../meet-url.js";
import { createMeetWithBrowserProxyOnNode } from "./chrome-create.js";
import {
  meetLeaveScript,
  meetStatusScript,
  meetTranscriptScript,
} from "./google-meet-page-scripts.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./google-meet-platform-constants.js";
import {
  forceMeetEnglishUi,
  isEnglishMeetTab,
  isRecoverableMeetTab,
  isSameMeetUrlForReuse,
  normalizeMeetUrlForReuse,
  readMeetAuthUser,
} from "./google-meet-urls.js";
import { buildMeetDtmfSequence, normalizeDialInNumber, prefixDtmfWait } from "./twilio.js";
import type { GoogleMeetChromeHealth, GoogleMeetTranscriptSnapshot } from "./types.js";

type GoogleMeetDialInParams = {
  dialInNumber?: string;
  defaultDialInNumber?: string;
  pin?: string;
  defaultPin?: string;
  dtmfSequence?: string;
  defaultDtmfSequence?: string;
  dtmfDelayMs: number;
};

type GoogleMeetDialInPlan = {
  number?: string;
  pin?: string;
  dtmfSequence?: string;
};

export function isGoogleMeetTalkBackMode(mode: GoogleMeetMode): boolean {
  return mode === "agent" || mode === "bidi";
}

function parseMeetBrowserStatus(result: unknown): GoogleMeetChromeHealth | undefined {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const raw = record.result;
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  let parsed: {
    inCall?: boolean;
    micMuted?: boolean;
    lobbyWaiting?: boolean;
    leaveReason?: string;
    captioning?: boolean;
    captionsEnabledAttempted?: boolean;
    transcriptLines?: number;
    lastCaptionAt?: string;
    lastCaptionSpeaker?: string;
    lastCaptionText?: string;
    recentTranscript?: GoogleMeetChromeHealth["recentTranscript"];
    audioOutputRouted?: boolean;
    audioOutputDeviceLabel?: string;
    audioOutputRouteError?: string;
    manualActionRequired?: boolean;
    manualActionReason?: GoogleMeetChromeHealth["manualActionReason"];
    manualActionMessage?: string;
    url?: string;
    title?: string;
    notes?: string[];
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error("Google Meet browser status JSON is malformed.");
  }
  return {
    inCall: parsed.inCall,
    micMuted: parsed.micMuted,
    lobbyWaiting: parsed.lobbyWaiting,
    leaveReason: parsed.leaveReason,
    captioning: parsed.captioning,
    captionsEnabledAttempted: parsed.captionsEnabledAttempted,
    transcriptLines: parsed.transcriptLines,
    lastCaptionAt: parsed.lastCaptionAt,
    lastCaptionSpeaker: parsed.lastCaptionSpeaker,
    lastCaptionText: parsed.lastCaptionText,
    recentTranscript: parsed.recentTranscript,
    audioOutputRouted: parsed.audioOutputRouted,
    audioOutputDeviceLabel: parsed.audioOutputDeviceLabel,
    audioOutputRouteError: parsed.audioOutputRouteError,
    manualActionRequired: parsed.manualActionRequired,
    manualActionReason: parsed.manualActionReason,
    manualActionMessage: parsed.manualActionMessage,
    browserUrl: parsed.url,
    browserTitle: parsed.title,
    status: "browser-control",
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.filter((note): note is string => typeof note === "string")
      : undefined,
  };
}

function parsePermissionGrantNotes(result: unknown): string[] {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const unsupportedPermissions = Array.isArray(record.unsupportedPermissions)
    ? record.unsupportedPermissions.filter((value): value is string => typeof value === "string")
    : [];
  const notes = ["Granted Meet microphone/camera permissions through browser control."];
  if (unsupportedPermissions.includes("speakerSelection")) {
    notes.push("Chrome did not accept the optional Meet speaker-selection permission.");
  }
  return notes;
}

function parseMeetTranscriptSnapshot(
  result: unknown,
): GoogleMeetTranscriptSnapshot & { sessionMatched?: boolean; urlMatched?: boolean } {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const raw = record.result;
  if (typeof raw !== "string" || !raw.trim()) {
    return { droppedLines: 0, lines: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Google Meet transcript JSON is malformed.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Google Meet transcript payload is invalid.");
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

function parseMeetLeaveResult(result: unknown): {
  departed: boolean;
  leaveAction?: "leave" | "confirm";
  urlMatched?: boolean;
} {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const raw = record.result;
  if (typeof raw !== "string" || !raw.trim()) {
    return { departed: false };
  }
  try {
    const parsed = JSON.parse(raw) as {
      departed?: boolean;
      leaveAction?: string;
      urlMatched?: boolean;
    };
    const leaveAction =
      parsed.leaveAction === "leave" || parsed.leaveAction === "confirm"
        ? parsed.leaveAction
        : undefined;
    return {
      departed: parsed.departed === true,
      ...(leaveAction ? { leaveAction } : {}),
      ...(typeof parsed.urlMatched === "boolean" ? { urlMatched: parsed.urlMatched } : {}),
    };
  } catch {
    return { departed: false };
  }
}

function classifyMeetManualAction(
  health: GoogleMeetChromeHealth,
): { category: MeetingManualActionCategory; reason: string; message: string } | undefined {
  if (!health.manualActionRequired || !health.manualActionReason || !health.manualActionMessage) {
    return undefined;
  }
  const category: MeetingManualActionCategory =
    health.manualActionReason === "google-login-required"
      ? "login-required"
      : health.manualActionReason === "meet-admission-required"
        ? "admission-required"
        : health.manualActionReason === "meet-permission-required"
          ? "permission-required"
          : health.manualActionReason === "meet-audio-choice-required"
            ? "audio-choice-required"
            : health.manualActionReason === "meet-locale-required"
              ? "locale-required"
              : health.manualActionReason === "meet-session-conflict"
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

export const GOOGLE_MEET_PLATFORM_ADAPTER: MeetingPlatformAdapter<
  MeetingBrowserJoinSession<GoogleMeetMode>,
  GoogleMeetMode,
  GoogleMeetChromeHealth,
  GoogleMeetTranscriptSnapshot,
  { runtime: PluginRuntime; config: GoogleMeetConfig },
  Awaited<ReturnType<typeof createMeetWithBrowserProxyOnNode>>,
  GoogleMeetDialInParams,
  GoogleMeetDialInPlan
> = {
  id: "google-meet",
  displayName: "Google Meet",
  browserLabel: "Meet",
  logScope: "[google-meet]",
  // Paired nodes install this exact command name; core injects it, never renames it.
  nodeCommandName: GOOGLE_MEET_NODE_COMMAND,
  nodeConfigPath: "plugins.entries.google-meet.config.chromeNode.node",
  urls: {
    validateAndNormalize: normalizeMeetUrl,
    normalizeForReuse: normalizeMeetUrlForReuse,
    isSameMeeting: isSameMeetUrlForReuse,
    buildJoinUrl: (session) => forceMeetEnglishUi(session.url),
    accountHint: readMeetAuthUser,
    isPreferredJoinUrl: isEnglishMeetTab,
    isRecoverableTab: isRecoverableMeetTab,
    localeAction: (tab) => {
      if (!normalizeMeetUrlForReuse(tab.url) || isEnglishMeetTab(tab.url)) {
        return undefined;
      }
      return {
        category: "locale-required",
        reason: "meet-locale-required",
        message:
          "The existing Meet tab is not pinned to English. Open the meeting with ?hl=en, then retry recovery.",
      };
    },
  },
  browser: {
    allowsMicrophone: isGoogleMeetTalkBackMode,
    buildStatusJoinScript: (params) =>
      meetStatusScript({
        allowMicrophone: isGoogleMeetTalkBackMode(params.mode),
        autoJoin: params.autoJoin,
        captionSessionId: params.meetingSessionId || undefined,
        captureCaptions: params.captureCaptions,
        guestName: params.guestName,
        readOnly: params.readOnly,
      }),
    parseStatus: parseMeetBrowserStatus,
    classifyManualAction: classifyMeetManualAction,
    browserControlUnavailable: () => ({
      category: "browser-control-unavailable",
      reason: "browser-control-unavailable",
      message:
        "Open the OpenClaw browser profile, finish Google Meet login, admission, or permission prompts, then retry.",
    }),
    buildLeaveScript: meetLeaveScript,
    parseLeaveResult: parseMeetLeaveResult,
    captions: {
      enabled: (mode) => mode === "transcribe",
      buildTranscriptScript: ({ finalize, meetingSessionId, meetingUrl }) =>
        meetTranscriptScript(meetingUrl, meetingSessionId, finalize),
      parseTranscript: parseMeetTranscriptSnapshot,
    },
    permissions: ({ allowMicrophone }) =>
      allowMicrophone
        ? {
            origin: "https://meet.google.com",
            permissions: ["audioCapture", "videoCapture"],
            optionalPermissions: ["speakerSelection"],
          }
        : undefined,
    permissionNotes: ({ allowMicrophone, error, result }) => {
      if (!allowMicrophone) {
        return ["Observe-only mode skips Meet microphone/camera permission grants."];
      }
      if (error) {
        return [
          `Could not grant Meet media permissions automatically: ${formatErrorMessage(error)}`,
        ];
      }
      return parsePermissionGrantNotes(result);
    },
  },
  create: {
    browser: createMeetWithBrowserProxyOnNode,
  },
  dialIn: {
    buildPlan: (params) => {
      const number = normalizeDialInNumber(params.dialInNumber ?? params.defaultDialInNumber);
      const pin = params.pin ?? params.defaultPin;
      const rawDtmfSequence = buildMeetDtmfSequence({
        pin,
        dtmfSequence: params.dtmfSequence ?? params.defaultDtmfSequence,
      });
      const dtmfSequence =
        params.dtmfSequence || params.defaultDtmfSequence
          ? rawDtmfSequence
          : prefixDtmfWait(rawDtmfSequence, params.dtmfDelayMs);
      return { number, pin, dtmfSequence };
    },
  },
};

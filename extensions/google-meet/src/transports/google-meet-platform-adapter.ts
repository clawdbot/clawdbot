// Google Meet adapter: platform URL, DOM, wire-value, and manual-action ownership.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  MeetingPlatformAdapter,
  type MeetingBrowserJoinSession,
  type MeetingManualActionCategory,
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

const manualActionCategories = new Map<string, MeetingManualActionCategory>([
  ["browser-control-unavailable", "browser-control-unavailable"],
  ["google-login-required", "login-required"],
  ["meet-admission-required", "admission-required"],
  ["meet-audio-choice-required", "audio-choice-required"],
  ["meet-locale-required", "locale-required"],
  ["meet-permission-required", "permission-required"],
  ["meet-session-conflict", "session-conflict"],
]);

function classifyManualActionReason(reason: string): MeetingManualActionCategory {
  return manualActionCategories.get(reason) ?? "custom";
}

export const GOOGLE_MEET_PLATFORM_ADAPTER = MeetingPlatformAdapter.create<
  MeetingBrowserJoinSession<GoogleMeetMode>,
  GoogleMeetMode,
  GoogleMeetChromeHealth,
  GoogleMeetTranscriptSnapshot,
  { runtime: PluginRuntime; config: GoogleMeetConfig },
  Awaited<ReturnType<typeof createMeetWithBrowserProxyOnNode>>,
  GoogleMeetDialInParams,
  GoogleMeetDialInPlan
>({
  id: "google-meet",
  displayName: "Google Meet",
  browserLabel: "Meet",
  logScope: "[google-meet]",
  agentConsult: {
    surface: "a private Google Meet",
    userLabel: "Participant",
    assistantLabel: "Agent",
    questionSourceLabel: "participant",
    workingResponseLabel: "participant",
    extraSystemPrompt: [
      "You are a behind-the-scenes consultant for a live meeting voice agent.",
      "Prioritize a fast, speakable answer over exhaustive investigation.",
      "For tool-backed status checks, prefer one or two bounded read-only queries before answering.",
      "Do not print secret values or dump environment variables; only check whether required configuration is present.",
      "Be accurate, brief, and speakable.",
    ].join(" "),
  },
  session: {
    idPrefix: "meet",
    participantIdentity: (transport) =>
      transport === "twilio"
        ? "Twilio phone participant"
        : transport === "chrome-node"
          ? "signed-in Google Chrome profile on a paired node"
          : "signed-in Google Chrome profile",
  },
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
    allowsMicrophone: MeetingPlatformAdapter.isTalkBackMode,
    buildStatusJoinScript: (params) =>
      meetStatusScript({
        allowMicrophone: MeetingPlatformAdapter.isTalkBackMode(params.mode),
        autoJoin: params.autoJoin,
        captionSessionId: params.meetingSessionId || undefined,
        captureCaptions: params.captureCaptions,
        guestName: params.guestName,
        readOnly: params.readOnly,
      }),
    shouldRetryJoinStatus: (health) =>
      health.inCall === true &&
      health.manualAction?.reason === "meet-audio-choice-required" &&
      (health.audioInputRouted !== true || health.audioOutputRouted !== true),
    browserControlUnavailable: () => ({
      category: "browser-control-unavailable",
      reason: "browser-control-unavailable",
      message:
        "Open the OpenClaw browser profile, finish Google Meet login, admission, or permission prompts, then retry.",
    }),
    buildLeaveScript: meetLeaveScript,
    captions: {
      // Durable notes observe the caption stream in every mode; live transcript
      // visibility remains gated by MeetingSessionRuntime.
      enabled: (_mode) => true,
      buildTranscriptScript: ({ finalize, meetingSessionId, meetingUrl }) =>
        meetTranscriptScript(meetingUrl, meetingSessionId, finalize),
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
  parsing: {
    classifyManualActionReason,
    displayName: "Meet",
    invalidTranscriptMessage: "Google Meet transcript payload is invalid.",
    malformedStatusMessage: "Google Meet browser status JSON is malformed.",
    malformedTranscriptMessage: "Google Meet transcript JSON is malformed.",
    statusFields: (parsed) => ({
      leaveReason: typeof parsed.leaveReason === "string" ? parsed.leaveReason : undefined,
    }),
  },
});

import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";
import { resolveGoogleMeetConfig } from "./config.js";

export const googleMeetConfigSchema = {
  parse(value: unknown) {
    return resolveGoogleMeetConfig(value);
  },
};

export const GoogleMeetToolSchema = Type.Object({
  action: Type.String({
    enum: [
      "join",
      "create",
      "status",
      "transcript",
      "setup_status",
      "resolve_space",
      "preflight",
      "latest",
      "calendar_events",
      "artifacts",
      "attendance",
      "export",
      "recover_current_tab",
      "leave",
      "end_active_conference",
      "speak",
      "test_speech",
      "test_listen",
    ],
    description:
      "Google Meet action to run. create creates and joins by default; pass join=false to only mint a URL. After a timeout or unclear browser state, call recover_current_tab before retrying join.",
  }),
  join: Type.Optional(
    Type.Boolean({
      description: "For action=create, set false to create the URL without joining.",
    }),
  ),
  accessType: Type.Optional(
    Type.String({
      enum: ["OPEN", "TRUSTED", "RESTRICTED"],
      description:
        "For action=create with Google Meet OAuth, configure who can join without knocking.",
    }),
  ),
  entryPointAccess: Type.Optional(
    Type.String({
      enum: ["ALL", "CREATOR_APP_ONLY"],
      description: "For action=create with Google Meet OAuth, configure allowed join entry points.",
    }),
  ),
  url: Type.Optional(Type.String({ description: "Explicit https://meet.google.com/... URL" })),
  transport: Type.Optional(
    Type.String({ enum: ["chrome", "chrome-node", "twilio"], description: "Join transport" }),
  ),
  mode: Type.Optional(
    Type.String({
      enum: ["agent", "bidi", "transcribe"],
      description:
        "Join mode. agent uses realtime transcription, the configured OpenClaw agent, and regular TTS. bidi uses the realtime voice model directly. transcribe joins observe-only.",
    }),
  ),
  dialInNumber: Type.Optional(
    Type.String({
      description:
        "Meet dial-in phone number for Twilio. Required for Twilio unless twilio.defaultDialInNumber is configured; Meet URLs cannot be dialed directly.",
    }),
  ),
  pin: Type.Optional(
    Type.String({ description: "Meet phone PIN for Twilio; # is appended if omitted" }),
  ),
  dtmfSequence: Type.Optional(Type.String({ description: "Explicit DTMF sequence for Twilio" })),
  sessionId: Type.Optional(Type.String({ description: "Meet session ID" })),
  sinceIndex: Type.Optional(
    Type.Integer({
      description: "For transcript, resume from the previous response's nextIndex.",
      minimum: 0,
    }),
  ),
  message: Type.Optional(Type.String({ description: "Realtime instructions to speak now" })),
  timeoutMs: optionalPositiveIntegerSchema({ description: "Probe timeout in milliseconds" }),
  meeting: Type.Optional(Type.String({ description: "Meet URL, meeting code, or spaces/{id}" })),
  today: Type.Optional(
    Type.Boolean({
      description: "For latest, artifacts, or attendance, find a Meet link on today's calendar.",
    }),
  ),
  event: Type.Optional(
    Type.String({
      description: "For latest, artifacts, or attendance, find a matching Calendar event.",
    }),
  ),
  calendarId: Type.Optional(Type.String({ description: "Calendar id for today/event lookup" })),
  conferenceRecord: Type.Optional(
    Type.String({ description: "Meet conferenceRecords/{id} resource name or id" }),
  ),
  pageSize: optionalPositiveIntegerSchema({ description: "Meet API page size for list actions" }),
  includeTranscriptEntries: Type.Optional(
    Type.Boolean({ description: "For artifacts, include structured transcript entries" }),
  ),
  includeDocumentBodies: Type.Optional(
    Type.Boolean({
      description:
        "For artifacts/export, export linked transcript and smart-note Google Docs text through Drive.",
    }),
  ),
  outputDir: Type.Optional(Type.String({ description: "For export, output directory" })),
  zip: Type.Optional(Type.Boolean({ description: "For export, also write a .zip archive" })),
  dryRun: Type.Optional(
    Type.Boolean({
      description: "For export, return the manifest without writing files.",
    }),
  ),
  includeAllConferenceRecords: Type.Optional(
    Type.Boolean({
      description:
        "For artifacts, attendance, or export with meeting input, fetch all conference records instead of only the latest.",
    }),
  ),
  mergeDuplicateParticipants: Type.Optional(
    Type.Boolean({ description: "For attendance, merge duplicate participant resources." }),
  ),
  lateAfterMinutes: optionalPositiveIntegerSchema({
    description: "For attendance, mark participants late after this many minutes.",
  }),
  earlyBeforeMinutes: optionalPositiveIntegerSchema({
    description: "For attendance, mark early leavers before this many minutes.",
  }),
  accessToken: Type.Optional(Type.String({ description: "Access token override" })),
  refreshToken: Type.Optional(Type.String({ description: "Refresh token override" })),
  clientId: Type.Optional(Type.String({ description: "OAuth client id override" })),
  clientSecret: Type.Optional(Type.String({ description: "OAuth client secret override" })),
  expiresAt: Type.Optional(Type.Number({ description: "Cached access token expiry ms" })),
});

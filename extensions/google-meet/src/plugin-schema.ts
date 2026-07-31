import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";
import { resolveGoogleMeetConfig } from "./config.js";

export const googleMeetConfigSchema = {
  parse(value: unknown) {
    return resolveGoogleMeetConfig(value);
  },
  uiHints: {
    "defaults.meeting": {
      label: "Default Meeting",
      help: "Meet URL, meeting code, or spaces/{id} used when CLI commands omit a meeting.",
    },
    "preview.enrollmentAcknowledged": {
      label: "Preview Acknowledged",
      help: "Confirms you understand the Google Meet Media API is still Developer Preview.",
      advanced: true,
    },
    defaultTransport: {
      label: "Default Transport",
      help: "Chrome uses a signed-in browser profile. Chrome-node runs Chrome on a paired node. Twilio uses Meet dial-in numbers.",
    },
    defaultMode: {
      label: "Default Mode",
      help: "Agent uses realtime transcription plus regular OpenClaw TTS. Bidi uses the realtime voice model directly. Transcribe observes only.",
    },
    "chrome.audioBackend": {
      label: "Chrome Audio Backend",
      help: "BlackHole 2ch is required for local duplex audio routing.",
    },
    "chrome.launch": { label: "Launch Chrome" },
    "chrome.browserProfile": { label: "Chrome Profile", advanced: true },
    "chrome.guestName": {
      label: "Guest Name",
      help: "Used when Chrome lands on the signed-out Meet guest-name screen.",
    },
    "chrome.reuseExistingTab": {
      label: "Reuse Existing Meet Tab",
      help: "Avoids opening duplicate tabs for the same Meet URL.",
    },
    "chrome.autoJoin": {
      label: "Auto Join Guest Screen",
      help: "Best-effort guest-name fill and Join Now click through OpenClaw browser automation.",
    },
    "chrome.waitForInCallMs": {
      label: "Wait For In-Call (ms)",
      help: "Waits for Chrome to report that the Meet tab is in-call before the realtime intro speaks.",
      advanced: true,
    },
    "chrome.audioFormat": {
      label: "Audio Format",
      help: "Command-pair audio format. PCM16 24 kHz is the default Chrome/Meet path; G.711 mu-law 8 kHz remains available for legacy command pairs.",
      advanced: true,
    },
    "chrome.audioBufferBytes": {
      label: "Audio Buffer Bytes",
      help: "SoX processing buffer for generated Chrome command-pair audio commands. Lower values reduce latency but may underrun on busy hosts.",
      advanced: true,
    },
    "chrome.audioInputCommand": {
      label: "Audio Input Command",
      help: "Command that writes meeting audio to stdout in chrome.audioFormat.",
      advanced: true,
    },
    "chrome.audioOutputCommand": {
      label: "Audio Output Command",
      help: "Command that reads assistant audio from stdin in chrome.audioFormat.",
      advanced: true,
    },
    "chrome.bargeInInputCommand": {
      label: "Barge-In Input Command",
      help: "Optional Gateway-hosted microphone command that writes signed 16-bit little-endian mono PCM for human interruption detection while assistant playback is active.",
      advanced: true,
    },
    "chrome.bargeInRmsThreshold": {
      label: "Barge-In RMS Threshold",
      help: "RMS level on chrome.bargeInInputCommand that counts as a human interruption.",
      advanced: true,
    },
    "chrome.bargeInPeakThreshold": {
      label: "Barge-In Peak Threshold",
      help: "Peak level on chrome.bargeInInputCommand that counts as a human interruption.",
      advanced: true,
    },
    "chrome.bargeInCooldownMs": {
      label: "Barge-In Cooldown (ms)",
      help: "Minimum delay between repeated barge-in clears.",
      advanced: true,
    },
    "chrome.audioBridgeCommand": { label: "Audio Bridge Command", advanced: true },
    "chrome.audioBridgeHealthCommand": {
      label: "Audio Bridge Health Command",
      advanced: true,
    },
    "chromeNode.node": {
      label: "Chrome Node",
      help: "Node id/name/IP that owns Chrome, BlackHole, and SoX for chrome-node transport.",
      advanced: true,
    },
    "twilio.defaultDialInNumber": {
      label: "Default Dial-In Number",
      placeholder: "+15551234567",
    },
    "twilio.defaultPin": { label: "Default PIN", advanced: true },
    "twilio.defaultDtmfSequence": { label: "Default DTMF Sequence", advanced: true },
    "voiceCall.enabled": { label: "Delegate To Voice Call" },
    "voiceCall.gatewayUrl": { label: "Voice Call Gateway URL", advanced: true },
    "voiceCall.token": {
      label: "Voice Call Gateway Token",
      sensitive: true,
      advanced: true,
    },
    "voiceCall.requestTimeoutMs": {
      label: "Voice Call Request Timeout (ms)",
      advanced: true,
    },
    "voiceCall.dtmfDelayMs": {
      label: "DTMF Wait Before PIN (ms)",
      help: "Leading Twilio wait time before playing a PIN-derived Meet DTMF sequence. Increase it if Meet asks for the PIN after DTMF was sent.",
      advanced: true,
    },
    "voiceCall.postDtmfSpeechDelayMs": {
      label: "Post-DTMF Speech Delay (ms)",
      help: "Delay before requesting the realtime intro greeting after Voice Call starts the Twilio leg.",
      advanced: true,
    },
    "voiceCall.introMessage": { label: "Voice Call Intro Message", advanced: true },
    "realtime.strategy": {
      label: "Realtime Strategy",
      help: "Legacy realtime alias setting. Use mode=agent or mode=bidi for new Meet joins.",
    },
    "realtime.provider": {
      label: "Speech Provider",
      help: "Compatibility fallback for both realtime transcription and bidi voice. Prefer realtime.transcriptionProvider and realtime.voiceProvider for new configs.",
    },
    "realtime.transcriptionProvider": {
      label: "Realtime Transcription Provider",
      help: "Agent mode uses this provider to transcribe meeting audio before regular OpenClaw TTS answers.",
    },
    "realtime.voiceProvider": {
      label: "Bidi Voice Provider",
      help: "Bidi mode uses this realtime voice provider. Falls back to realtime.provider when unset.",
    },
    "realtime.model": {
      label: "Bidi Realtime Model",
      help: "Only used by mode=bidi. Agent mode answers with the configured OpenClaw agent and regular TTS.",
      advanced: true,
    },
    "realtime.instructions": { label: "Realtime Instructions", advanced: true },
    "realtime.introMessage": {
      label: "Realtime Intro Message",
      help: "Spoken once when the realtime bridge is ready. Set to an empty string to join silently.",
    },
    "realtime.agentId": {
      label: "Realtime Consult Agent",
      help: 'OpenClaw agent id used by openclaw_agent_consult. Defaults to "main".',
      advanced: true,
    },
    "realtime.toolPolicy": {
      label: "Realtime Tool Policy",
      help: "Safe read-only tools are available by default; owner requests can unlock broader tools.",
      advanced: true,
    },
    "oauth.clientId": { label: "OAuth Client ID" },
    "oauth.clientSecret": { label: "OAuth Client Secret", sensitive: true },
    "oauth.refreshToken": { label: "OAuth Refresh Token", sensitive: true },
    "oauth.accessToken": {
      label: "Cached Access Token",
      sensitive: true,
      advanced: true,
    },
    "oauth.expiresAt": {
      label: "Cached Access Token Expiry",
      help: "Unix epoch milliseconds used only for the cached access-token fast path.",
      advanced: true,
    },
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

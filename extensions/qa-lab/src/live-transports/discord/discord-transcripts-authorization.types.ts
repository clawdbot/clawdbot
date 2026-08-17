export type DiscordTranscriptsVoiceAuthorizationRun = {
  kind: "transcripts-voice-authorization";
  allowedSessionId: string;
  deniedSessionId: string;
  negativeMarker: string;
  positiveMarker: string;
  stopMarker: string;
};

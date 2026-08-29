const MSTEAMS_VOICE_ACTIVITY_TYPE = "application/vnd.microsoft.activity.voice+json";

export function buildMSTeamsVoiceActivity(params: {
  contentType: string;
  contentUrl: string;
  transcription?: string;
}): Record<string, unknown> {
  if (!params.contentType.toLowerCase().startsWith("audio/")) {
    throw new Error("MS Teams voice messages require audio media.");
  }
  const transcription = params.transcription?.trim();
  return {
    type: "message",
    valueType: MSTEAMS_VOICE_ACTIVITY_TYPE,
    value: {
      contentType: params.contentType,
      contentUrl: params.contentUrl,
      ...(transcription ? { transcription } : {}),
    },
  };
}

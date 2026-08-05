type PlaybackMediaKind = "audio" | "video";
type PlaybackMode = "native" | "transcode";

type PlaybackPolicyEntry = {
  nativeMimeTypes: readonly string[];
  codecProbeInputFormats: Readonly<Record<string, string>>;
  transcodeInputFormats: Readonly<Record<string, string>>;
  target: { contentType: string; extension: `.${string}` };
};

type PlaybackTranscodeTestApi = {
  PLAYBACK_TRANSCODE_POLICY: Record<PlaybackMediaKind, PlaybackPolicyEntry>;
  resolvePlaybackMode(mimeType: string, policy: PlaybackPolicyEntry): PlaybackMode | undefined;
};

function getTestApi(): PlaybackTranscodeTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.playbackTranscodeTestApi")
  ];
  if (!api) {
    throw new Error("playback transcode test API is unavailable");
  }
  return api as PlaybackTranscodeTestApi;
}

export function getPlaybackTranscodePolicyForTest(): PlaybackTranscodeTestApi["PLAYBACK_TRANSCODE_POLICY"] {
  return getTestApi().PLAYBACK_TRANSCODE_POLICY;
}

export function resolvePlaybackModeForTest(
  mimeType: string,
  kind: PlaybackMediaKind,
): PlaybackMode | undefined {
  const api = getTestApi();
  return api.resolvePlaybackMode(mimeType, api.PLAYBACK_TRANSCODE_POLICY[kind]);
}

import type { MediaKind } from "@openclaw/media-core/constants";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import type { PlaybackMediaProbeResult } from "./media-probe.js";

type PlaybackMediaKind = Extract<MediaKind, "audio" | "video">;

/** Combines selected audio/video codec facts without letting unknown facts hide incompatibility. */
export function resolveNativePlaybackCodecCompatibility(
  kind: PlaybackMediaKind,
  mimeType: string,
  probe: PlaybackMediaProbeResult,
): boolean | undefined {
  if (kind === "audio") {
    const codec = probe.audioCodec;
    if (probe.audioStreamIndex === undefined || !codec) {
      return undefined;
    }
    if (/^audio\/(?:x-wav|wav|wave)$/.test(normalizeMimeType(mimeType) ?? "")) {
      return codec === "pcm_s16le" || codec === "pcm_u8";
    }
    return codec === "mp3" || (normalizeMimeType(mimeType) !== "audio/mpeg" && codec === "aac");
  }

  const audioCompatible =
    probe.audioStreamIndex === undefined
      ? probe.audioCodec
        ? undefined
        : true
      : probe.audioCodec
        ? probe.audioCodec === "aac" || probe.audioCodec === "mp3"
        : undefined;
  let videoCompatible: boolean | undefined;
  if (probe.videoCodec && probe.videoStreamIndex !== undefined) {
    const portableProfile =
      probe.videoProfile === "baseline" ||
      probe.videoProfile === "constrained baseline" ||
      probe.videoProfile === "main" ||
      probe.videoProfile === "high";
    const portablePixelFormat =
      probe.videoPixelFormat === "yuv420p" || probe.videoPixelFormat === "yuvj420p";
    videoCompatible =
      probe.videoCodec === "h264" && probe.videoProfile && probe.videoPixelFormat
        ? portableProfile && portablePixelFormat
        : probe.videoCodec === "h264"
          ? undefined
          : false;
  }
  return audioCompatible === false || videoCompatible === false
    ? false
    : audioCompatible === true && videoCompatible === true
      ? true
      : undefined;
}

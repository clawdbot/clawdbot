/**
 * @deprecated Broad public SDK barrel. Prefer focused media-store, media-mime,
 * outbound-media, and capability runtime subpaths.
 */

export { isVoiceCompatibleAudio, isVoiceMessageCompatibleAudio } from "../media/audio.js";
export { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
export { parseMediaContentLength } from "@openclaw/media-core/content-length";
export { MAX_AUDIO_BYTES } from "@openclaw/media-core/constants";
export { readRemoteMediaBuffer, saveResponseMedia, MediaFetchError } from "../media/fetch.js";
export type { FetchLike, SavedRemoteMedia } from "../media/fetch.js";
export { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "../media/ffmpeg-limits.js";
export {
  isInboundPathAllowed,
  normalizeInboundPathRoots,
} from "@openclaw/media-core/inbound-path-policy";

export {
  IMAGE_REDUCE_QUALITY_STEPS,
  buildImageResizeSideGrid,
  getImageMetadata,
  isImageProcessorUnavailableError,
  parseFfprobeCodecAndSampleRate,
  probeVideoDimensions,
  resolveFfmpegBin,
  resizeToJpeg,
  runFfmpeg,
  runFfprobe,
  transcodeAudioBuffer,
  transcodeAudioBufferToOpus,
} from "../media/media-services.js";
export {
  detectMime,
  extensionForMime,
  getFileExtension,
  isGifMedia,
} from "@openclaw/media-core/mime";
export { resolveOutboundAttachmentFromUrl } from "../media/outbound-attachment.js";
export { encodePngRgba, fillPixel } from "../media/png-encode.ts";
export { renderQrPngBase64, renderQrPngDataUrl, writeQrPngTempFile } from "../media/qr-image.ts";
export { renderQrTerminal } from "../media/qr-terminal.ts";

export { readResponseTextSnippet, readResponseWithLimit } from "../infra/http-body.js";
export { ensureMediaDir, extractOriginalFilename, saveMediaSource } from "../media/store.js";
export type { SavedMedia } from "../media/store.js";
export { unlinkIfExists } from "../media/temp-files.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export {
  createDirectTextMediaOutbound,
  createScopedChannelMediaMaxBytesResolver,
} from "../channels/plugins/outbound/direct-text-media.js";
export { buildAgentMediaPayload } from "./agent-media-payload.js";
export { transcribeFirstAudio } from "../media-understanding/audio-preflight.ts";
export {
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "../media-understanding/defaults.js";
export { describeImageWithModel } from "../media-understanding/image-runtime.ts";
export { resolveAutoImageModel } from "../media-understanding/runner.js";

export { normalizePollDurationHours, normalizePollInput } from "../polls.js";
export type { PollInput } from "../polls.js";

export { buildOutboundMediaLoadOptions } from "../media/load-options.js";
export type { OutboundMediaAccess, OutboundMediaReadFile } from "../media/load-options.js";
export { fetchRemoteMedia, saveRemoteMedia } from "../media/fetch.js";
export { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
export { getMediaDir, saveMediaBuffer } from "../media/store.js";
export { kindFromMime } from "@openclaw/media-core/mime";
export {
  MAX_IMAGE_BYTES,
  maxBytesForKind,
  mediaKindFromMime,
} from "@openclaw/media-core/constants";
export type { MediaKind } from "@openclaw/media-core/constants";

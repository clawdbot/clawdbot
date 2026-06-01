/**
 * @deprecated Broad public SDK barrel. Prefer focused media-store, media-mime,
 * outbound-media, and capability runtime subpaths.
 */

export * from "../media/audio.js";
export * from "@openclaw/media-core/base64";
export * from "@openclaw/media-core/content-length";
export * from "@openclaw/media-core/constants";
export * from "../media/fetch.js";
export * from "../media/ffmpeg-limits.js";
export * from "@openclaw/media-core/inbound-path-policy";
export * from "../media/load-options.js";
export * from "../media/local-media-access.js";
export * from "../media/local-roots.js";
export {
  IMAGE_REDUCE_QUALITY_STEPS,
  ImageProcessorUnavailableError,
  MAX_IMAGE_INPUT_PIXELS,
  buildImageResizeSideGrid,
  convertHeicToJpeg,
  getImageMetadata,
  hasAlphaChannel,
  isImageProcessorUnavailableError,
  normalizeExifOrientation,
  optimizeImageToPng,
  parseFfprobeCodecAndSampleRate,
  parseFfprobeCsvFields,
  parseFfprobeVideoDimensions,
  probeVideoDimensions,
  resolveFfmpegBin,
  resizeToJpeg,
  resizeToPng,
  runFfmpeg,
  runFfprobe,
  transcodeAudioBuffer,
  transcodeAudioBufferToOpus,
  type AudioContainerTranscodeOutcome,
  type ImageMetadata,
  type MediaExecOptions,
  type VideoDimensions,
} from "../media/media-services.js";
export * from "@openclaw/media-core/mime";
export * from "../media/outbound-attachment.js";
export * from "../media/png-encode.ts";
export * from "../media/qr-image.ts";
export * from "../media/qr-terminal.ts";
export * from "@openclaw/media-core/read-byte-stream-with-limit";
export * from "@openclaw/media-core/read-response-with-limit";
export * from "../media/store.js";
export * from "../media/temp-files.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export * from "./agent-media-payload.js";
export * from "../media-understanding/audio-preflight.ts";
export * from "../media-understanding/defaults.js";
export * from "../media-understanding/image-runtime.ts";
export * from "../media-understanding/runner.js";
export { normalizeMediaProviderId } from "../media-understanding/provider-registry.js";
export * from "../polls.js";
export {
  createDirectTextMediaOutbound,
  createScopedChannelMediaMaxBytesResolver,
  resolveScopedChannelMediaMaxBytes,
} from "../channels/plugins/outbound/direct-text-media.js";

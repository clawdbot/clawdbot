// Maps speech-synthesis output metadata to a playable MIME type. Provider
// outputFormat strings are free-form (e.g. "mp3_44100_128", "pcm-wav"), so
// matching is prefix/suffix-based with the file extension as a tiebreaker.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

export function inferSpeechMimeType(
  outputFormat: string | undefined,
  fileExtension: string | undefined,
): string | undefined {
  const normalizedOutput = normalizeOptionalLowercaseString(outputFormat);
  const normalizedExtension = normalizeOptionalLowercaseString(fileExtension);
  if (
    normalizedOutput === "mp3" ||
    normalizedOutput?.startsWith("mp3_") ||
    normalizedOutput?.endsWith("-mp3") ||
    normalizedExtension === ".mp3"
  ) {
    return "audio/mpeg";
  }
  if (
    normalizedOutput === "opus" ||
    normalizedOutput?.startsWith("opus_") ||
    normalizedExtension === ".opus" ||
    normalizedExtension === ".ogg"
  ) {
    return "audio/ogg";
  }
  if (normalizedOutput?.endsWith("-wav") || normalizedExtension === ".wav") {
    return "audio/wav";
  }
  if (normalizedOutput?.endsWith("-webm") || normalizedExtension === ".webm") {
    return "audio/webm";
  }
  return undefined;
}

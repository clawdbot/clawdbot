// File-backed TTS output is owned by the canonical media store, not speech-core.
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import type { TtsAudioPersistence } from "../../packages/speech-core/src/tts-synthesis.js";
import { resolveGeneratedMediaMaxBytes } from "../media/configured-max-bytes.js";
import { saveMediaBuffer } from "../media/store.js";

const TTS_MEDIA_SUBDIR = "tool-speech-synthesis";

export const persistTtsAudioToMediaStore: TtsAudioPersistence = async ({
  audioBuffer,
  cfg,
  fileExtension,
}) => {
  const originalFilename = `voice${fileExtension}`;
  const saved = await saveMediaBuffer(
    audioBuffer,
    mimeTypeFromFilePath(originalFilename),
    TTS_MEDIA_SUBDIR,
    resolveGeneratedMediaMaxBytes(cfg, "audio"),
    originalFilename,
  );
  return saved.path;
};

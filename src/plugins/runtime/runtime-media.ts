import { mediaKindFromMime } from "@openclaw/media-core/constants";
import { detectMime } from "@openclaw/media-core/mime";
import { isVoiceCompatibleAudio } from "../../media/audio.js";
import { getImageMetadata, resizeToJpeg } from "../../media/media-services.js";
import { loadWebMedia } from "../../media/web-media.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeMedia(): PluginRuntime["media"] {
  return {
    loadWebMedia,
    detectMime,
    mediaKindFromMime,
    isVoiceCompatibleAudio,
    getImageMetadata,
    resizeToJpeg,
  };
}

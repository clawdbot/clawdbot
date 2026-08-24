// Runtime media helpers load and classify media attachments for plugin runtimes.
import { mediaKindFromMime } from "@openclaw/media-core/constants";
import { detectMime } from "@openclaw/media-core/mime";
import { isVoiceMessageCompatibleAudio } from "../../media/audio.js";
import { getImageMetadata, resizeToJpeg } from "../../media/media-services.js";
import { loadWebMedia } from "../../media/web-media.js";
import type { PluginRuntime } from "./types.js";

/** Creates the plugin runtime media facade. */
export function createRuntimeMedia(): PluginRuntime["media"] {
  return {
    loadWebMedia,
    detectMime,
    mediaKindFromMime,
    isVoiceCompatibleAudio: isVoiceMessageCompatibleAudio,
    getImageMetadata,
    resizeToJpeg,
  };
}

// Narrow media store helpers for channel runtimes that do not need the full media runtime.

export {
  CHANNEL_HISTORY_MEDIA_SUBDIR,
  readMediaBuffer,
  resolveMediaBufferPath,
  saveMediaBuffer,
  saveMediaSource,
  saveMediaStream,
} from "../media/store.js";
export type { SavedMedia } from "../media/store.js";

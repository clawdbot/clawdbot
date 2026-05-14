// Narrow media store helpers for channel runtimes that do not need the full media runtime.

export {
  readMediaBuffer,
  resolveMediaBufferPath,
  saveMediaBuffer,
  saveMediaStream,
} from "../media/store.js";
export type { SavedMedia } from "../media/store.js";

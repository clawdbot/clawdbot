// Narrow media MIME helper surface for plugins that do not need the full media runtime.

export {
  detectMime,
  extensionForMime,
  getFileExtension,
  mimeTypeFromFilePath,
  normalizeMimeType,
} from "../media/mime.js";
export { mediaKindFromMime, type MediaKind } from "../media/constants.js";

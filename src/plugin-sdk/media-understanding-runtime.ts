/**
 * Runtime SDK subpath for media understanding, image description, and audio transcription.
 */
export {
  describeImageFile,
  describeImageFileWithModel,
  describeVideoFile,
  extractStructuredWithModel,
  runMediaUnderstandingFile,
  transcribeAudioFile,
  type ExtractStructuredWithModelParams,
  type RunMediaUnderstandingFileParams,
  type RunMediaUnderstandingFileResult,
} from "../media-understanding/runtime.js";
